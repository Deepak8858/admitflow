import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { CONTRACT, WORKLOAD_ROLES, generate } from "./generate.mjs";

const regional = { "aws:RequestedRegion": CONTRACT.region };
const ar = (service, resource) => `arn:aws:${service}:${CONTRACT.region}:${CONTRACT.account}:${resource}`;
/** Build expected IAM authorization cases from the verified deployment identifiers. */
export function validationCases(input) {
  const cases = [];
  const add = (id, phase, identity, action, resource, expected, context = {}) => cases.push({ id, phase, identity, action, resource, expected, context: { ...regional, ...context } });
  const stack = ar("cloudformation", "stack/AdmitFlow-prod/offline-stack-id");
  add("own-stack", "deployment", "deploy", "cloudformation:CreateChangeSet", stack, "allowed", { "cloudformation:RoleArn": CONTRACT.cfnRoleArn });
  add("other-stack", "deployment", "deploy", "cloudformation:CreateChangeSet", stack.replace("AdmitFlow-prod", "AnotherStack"), "implicitDeny", { "cloudformation:RoleArn": CONTRACT.cfnRoleArn });
  add("missing-cfn-role", "deployment", "deploy", "cloudformation:CreateChangeSet", stack, "implicitDeny");
  add("wrong-cfn-role", "deployment", "deploy", "cloudformation:CreateChangeSet", stack, "implicitDeny", { "cloudformation:RoleArn": CONTRACT.deployRoleArn });
  add("wrong-region", "deployment", "deploy", "cloudformation:DescribeStacks", stack, "implicitDeny", { "aws:RequestedRegion": "us-east-1" });
  add("wrong-account", "deployment", "deploy", "cloudformation:DescribeStacks", stack.replace(CONTRACT.account, "111111111111"), "implicitDeny");
  for (const [index, role] of WORKLOAD_ROLES.entries()) {
    add(`bounded-role-${index}`, "deployment", "cloudformation", "iam:CreateRole", role.arn, "allowed", { "iam:PermissionsBoundary": role.boundaryArn });
    add(`missing-boundary-${index}`, "deployment", "cloudformation", "iam:CreateRole", role.arn, "implicitDeny");
    add(`wrong-boundary-${index}`, "deployment", "cloudformation", "iam:CreateRole", role.arn, "implicitDeny", { "iam:PermissionsBoundary": WORKLOAD_ROLES[(index + 1) % WORKLOAD_ROLES.length].boundaryArn });
  }
  add("unrelated-role", "deployment", "cloudformation", "iam:CreateRole", CONTRACT.deployRoleArn, "implicitDeny", { "iam:PermissionsBoundary": WORKLOAD_ROLES[0].boundaryArn });
  add("pass-cfn", "deployment", "deploy", "iam:PassRole", CONTRACT.cfnRoleArn, "allowed", { "iam:PassedToService": "cloudformation.amazonaws.com" });
  add("pass-cfn-wrong-service", "deployment", "deploy", "iam:PassRole", CONTRACT.cfnRoleArn, "implicitDeny", { "iam:PassedToService": "ecs-tasks.amazonaws.com" });
  add("pass-task", "deployment", "cloudformation", "iam:PassRole", WORKLOAD_ROLES[0].arn, "allowed", { "iam:PassedToService": "ecs-tasks.amazonaws.com" });
  add("pass-task-wrong-service", "deployment", "cloudformation", "iam:PassRole", WORKLOAD_ROLES[0].arn, "implicitDeny", { "iam:PassedToService": "lambda.amazonaws.com" });
  add("pass-unrelated-role", "deployment", "cloudformation", "iam:PassRole", CONTRACT.deployRoleArn, "implicitDeny", { "iam:PassedToService": "ecs-tasks.amazonaws.com" });
  add("self-policy-mutation", "deployment", "cloudformation", "iam:PutRolePolicy", CONTRACT.cfnRoleArn, "implicitDeny");
  add("bootstrap-trust-mutation", "deployment", "cloudformation", "iam:UpdateAssumeRolePolicy", CONTRACT.bootstrapRoleArn, "implicitDeny");
  add("boundary-delete", "deployment", "cloudformation", "iam:DeleteRolePermissionsBoundary", WORKLOAD_ROLES[0].arn, "explicitDeny");
  add("boundary-replace", "deployment", "cloudformation", "iam:PutRolePermissionsBoundary", WORKLOAD_ROLES[0].arn, "explicitDeny", { "iam:PermissionsBoundary": WORKLOAD_ROLES[1].boundaryArn });
  add("boundary-version", "deployment", "cloudformation", "iam:CreatePolicyVersion", WORKLOAD_ROLES[0].boundaryArn, "explicitDeny");
  for (const action of ["logs:PutResourcePolicy", "logs:DeleteResourcePolicy"]) add(`no-routine-${action}`, "deployment", "cloudformation", action, "*", "implicitDeny");
  add("publisher-push", "deployment", "publisher", "ecr:PutImage", ar("ecr", "repository/admitflow-prod"), "allowed");
  add("publisher-other-ecr", "deployment", "publisher", "ecr:PutImage", ar("ecr", "repository/other"), "implicitDeny");
  add("publisher-own-digest-evidence", "deployment", "publisher", "ecr:DescribeImages", ar("ecr", "repository/admitflow-prod"), "allowed");
  add("publisher-no-other-digest-evidence", "deployment", "publisher", "ecr:DescribeImages", ar("ecr", "repository/other"), "implicitDeny");
  add("publisher-no-other-region-digest-evidence", "deployment", "publisher", "ecr:DescribeImages", ar("ecr", "repository/admitflow-prod"), "implicitDeny", { "aws:RequestedRegion": "us-east-1" });
  add("bootstrap-regional-certificate-inventory", "prerequisites", "bootstrap", "acm:ListCertificates", "*", "allowed");
  add("bootstrap-no-other-region-certificate-inventory", "prerequisites", "bootstrap", "acm:ListCertificates", "*", "implicitDeny", { "aws:RequestedRegion": "us-east-1" });
  add("bootstrap-no-unverified-certificate-description", "prerequisites", "bootstrap", "acm:DescribeCertificate", input.certificateArn, "implicitDeny");
  add("publisher-no-secret", "deployment", "publisher", "secretsmanager:GetSecretValue", input.applicationSecretArn, "implicitDeny");
  add("publisher-no-passrole", "deployment", "publisher", "iam:PassRole", CONTRACT.cfnRoleArn, "implicitDeny", { "iam:PassedToService": "cloudformation.amazonaws.com" });
  const resourceTags = { "aws:ResourceTag/Application": "AdmitFlow", "aws:ResourceTag/Environment": "prod" };
  const requestTags = { "aws:RequestTag/Application": "AdmitFlow", "aws:RequestTag/Environment": "prod" };
  generate("cache-parameters-configure", input); // Exact identity is mandatory before deriving vectors.
  const parameters = input.cacheParameterGroupArn;
  const parameterTagContext = { ...requestTags, "aws:TagKeys": ["Application", "Environment"] };
  const parameterVariants = {
    neighbor: `${parameters}-other`, oldPrefix: ar("elasticache", "parametergroup:admitflow-prod-cacheparameters-test"),
    shortened: ar("elasticache", "parametergroup:admitf-cache-xlqszxaqy5hl"),
    account: parameters.replace(CONTRACT.account, "111111111111"), region: parameters.replace(CONTRACT.region, "us-east-1"),
  };
  for (const action of ["elasticache:CreateCacheParameterGroup", "elasticache:AddTagsToResource"]) {
    add(`cache-create-${action}`, "cache-parameters-create", "bootstrap", action, parameters, "allowed", parameterTagContext);
    for (const [name, context] of Object.entries({
      missingTags: {}, missingApplication: { ...parameterTagContext, "aws:RequestTag/Application": undefined },
      missingEnvironment: { ...parameterTagContext, "aws:RequestTag/Environment": undefined },
      wrongApplication: { ...parameterTagContext, "aws:RequestTag/Application": "Other" },
      wrongEnvironment: { ...parameterTagContext, "aws:RequestTag/Environment": "staging" },
      extraKeys: { ...parameterTagContext, "aws:TagKeys": ["Application", "Environment", "Other"] },
      missingKeys: requestTags, emptyKeys: { ...requestTags, "aws:TagKeys": [] },
      wrongRegion: { ...parameterTagContext, "aws:RequestedRegion": "us-east-1" },
    })) add(`cache-create-reject-${name}-${action}`, "cache-parameters-create", "bootstrap", action, parameters, "implicitDeny", context);
    for (const [name, resource] of Object.entries(parameterVariants)) add(`cache-create-reject-${name}-${action}`, "cache-parameters-create", "bootstrap", action, resource, "implicitDeny", parameterTagContext);
  }
  // Residual exact-name relabel authority is explicit, not disguised as create-only enforcement.
  add("cache-create-exact-name-retag-residual", "cache-parameters-create", "bootstrap", "elasticache:AddTagsToResource", parameters, "allowed", { ...parameterTagContext, "aws:ResourceTag/Application": "Other" });
  for (const phase of ["cache-parameters-create", "cache-parameters-configure"]) {
    for (const action of ["elasticache:DescribeCacheParameterGroups", "elasticache:DescribeCacheParameters", "elasticache:ListTagsForResource"]) {
      add(`${phase}-exact-read-${action}`, phase, "bootstrap", action, parameters, "allowed");
      add(`${phase}-no-inventory-${action}`, phase, "bootstrap", action, "*", "implicitDeny");
      add(`${phase}-no-other-region-read-${action}`, phase, "bootstrap", action, parameters, "implicitDeny", { "aws:RequestedRegion": "us-east-1" });
      for (const [name, resource] of Object.entries(parameterVariants)) add(`${phase}-reject-read-${name}-${action}`, phase, "bootstrap", action, resource, "implicitDeny");
    }
    for (const action of ["elasticache:DeleteCacheParameterGroup", "elasticache:ResetCacheParameterGroup", "elasticache:RemoveTagsFromResource", "elasticache:CreateCacheCluster", "elasticache:CreateReplicationGroup"]) {
      for (const [name, resource] of Object.entries({ parameters, cluster: ar("elasticache", "cluster:admitflow-prod-queue-001"), replication: ar("elasticache", "replicationgroup:admitflow-prod-queue") })) {
        add(`${phase}-no-${name}-${action}`, phase, "bootstrap", action, resource, "implicitDeny", { ...parameterTagContext, ...resourceTags });
      }
    }
  }
  add("cache-create-no-modify", "cache-parameters-create", "bootstrap", "elasticache:ModifyCacheParameterGroup", parameters, "implicitDeny", resourceTags);
  for (const action of ["elasticache:CreateCacheParameterGroup", "elasticache:AddTagsToResource"]) add(`cache-configure-no-${action}`, "cache-parameters-configure", "bootstrap", action, parameters, "implicitDeny", { ...parameterTagContext, ...resourceTags });
  const uses = ["elasticache:CreateReplicationGroup", "elasticache:ModifyReplicationGroup", "elasticache:DescribeCacheParameterGroups", "elasticache:DescribeCacheParameters", "elasticache:ListTagsForResource"];
  for (const [phase, identity, actions] of [
    ["cache-parameters-configure", "bootstrap", ["elasticache:ModifyCacheParameterGroup"]],
    ["deployment", "cloudformation", uses],
  ]) for (const action of actions) {
    add(`${phase}-tagged-cache-${action}`, phase, identity, action, parameters, "allowed", resourceTags);
    for (const [name, context] of Object.entries({
      missing: {}, application: { ...resourceTags, "aws:ResourceTag/Application": "Other" },
      environment: { ...resourceTags, "aws:ResourceTag/Environment": "staging" },
      missingApplication: { "aws:ResourceTag/Environment": "prod" }, missingEnvironment: { "aws:ResourceTag/Application": "AdmitFlow" },
      region: { ...resourceTags, "aws:RequestedRegion": "us-east-1" },
    })) add(`${phase}-reject-cache-${name}-${action}`, phase, identity, action, parameters, "implicitDeny", context);
    for (const [name, resource] of Object.entries(parameterVariants)) add(`${phase}-reject-cache-resource-${name}-${action}`, phase, identity, action, resource, "implicitDeny", resourceTags);
  }
  for (const identity of ["cloudformation", "deploy", "publisher", ...WORKLOAD_ROLES.map(role => `${role.name}-boundary.json`)]) {
    for (const action of ["elasticache:CreateCacheParameterGroup", "elasticache:ModifyCacheParameterGroup", "elasticache:DeleteCacheParameterGroup", "elasticache:ResetCacheParameterGroup", "elasticache:AddTagsToResource", "elasticache:RemoveTagsFromResource"]) {
      add(`${identity}-no-cache-admin-${action}`, "deployment", identity, action, parameters, identity === "admitflow-prod-migration-task-boundary.json" ? "explicitDeny" : "implicitDeny", { ...parameterTagContext, ...resourceTags });
    }
  }
  // Production-equivalent name from the 2026-09-25 CFN denial; not an existing snapshot.
  const snapshot = ar("elasticache", "snapshot:admitflow-prod-snapshot-queue-16l0wasktxzb6");
  const snapshotVariants = {
    oldPrefix: ar("elasticache", "snapshot:admitflow-prod-queue-16l0wasktxzb6"),
    probeStack: ar("elasticache", "snapshot:admitflow-lifecycle-20260925-snapshot-queue-16l0wasktxzb6"),
    neighborStack: snapshot.replace("prod-snapshot", "prod-other-snapshot"),
    logicalId: snapshot.replace("snapshot-queue-", "snapshot-queueauth-"),
    account: snapshot.replace(CONTRACT.account, "111111111111"),
    region: snapshot.replace(CONTRACT.region, "us-east-1"),
    partition: snapshot.replace("arn:aws:", "arn:aws-cn:"),
    inventory: "*",
  };
  const snapshotActions = ["elasticache:DeleteReplicationGroup", "elasticache:CreateSnapshot", "elasticache:DescribeSnapshots", "elasticache:AddTagsToResource", "elasticache:RemoveTagsFromResource", "elasticache:ListTagsForResource"];
  for (const action of snapshotActions) {
    add(`queue-snapshot-${action}`, "deployment", "cloudformation", action, snapshot, "allowed");
    for (const [name, resource] of Object.entries(snapshotVariants)) add(`queue-snapshot-reject-${name}-${action}`, "deployment", "cloudformation", action, resource, "implicitDeny");
    add(`queue-snapshot-reject-requested-region-${action}`, "deployment", "cloudformation", action, snapshot, "implicitDeny", { "aws:RequestedRegion": "us-east-1" });
  }
  for (const [name, resource] of Object.entries({ snapshot, ...snapshotVariants })) add(`queue-snapshot-no-delete-${name}`, "deployment", "cloudformation", "elasticache:DeleteSnapshot", resource, "implicitDeny");
  for (const [name, resource] of Object.entries({ replication: ar("elasticache", "replicationgroup:admitflow-prod-queue"), member: ar("elasticache", "cluster:admitflow-prod-queue-001") })) {
    // DeleteReplicationGroup supports replicationgroup/snapshot, not member cluster ARNs.
    const actions = ["elasticache:CreateSnapshot", "elasticache:AddTagsToResource", ...(name === "replication" ? ["elasticache:DeleteReplicationGroup"] : [])];
    for (const action of actions) add(`queue-snapshot-source-${name}-${action}`, "deployment", "cloudformation", action, resource, "allowed");
  }
  const vpc = ar("ec2", "vpc/vpc-11111111111111111");
  add("own-vpc-delete", "deployment", "cloudformation", "ec2:DeleteVpc", vpc, "allowed", resourceTags);
  add("unrelated-vpc-delete", "deployment", "cloudformation", "ec2:DeleteVpc", vpc, "implicitDeny");
  add("cannot-relabel-vpc", "deployment", "cloudformation", "ec2:CreateTags", vpc, "implicitDeny", requestTags);
  add("create-tagged-vpc", "deployment", "cloudformation", "ec2:CreateVpc", vpc, "allowed", requestTags);
  add("create-untagged-vpc", "deployment", "cloudformation", "ec2:CreateVpc", vpc, "implicitDeny");
  generate("tenant-key-configure", input); // Reject absent/unverified-shape key identifiers before deriving negative vectors.
  const key = input.tenantKeyArn;
  const otherKey = `${key.slice(0, -1)}${key.endsWith("0") ? "1" : "0"}`;
  const alias = ar("kms", "alias/admitflow-prod-tenant-credentials");
  const createContext = { "kms:KeySpec": "SYMMETRIC_DEFAULT", "kms:KeyUsage": "ENCRYPT_DECRYPT", "kms:KeyOrigin": "AWS_KMS", "kms:MultiRegion": "false", "kms:BypassPolicyLockoutSafetyCheck": "false" };
  add("bootstrap-create-untagged-key", "tenant-key-create", "bootstrap", "kms:CreateKey", "*", "allowed", createContext);
  for (const [name, context] of Object.entries({
    tagged: { "aws:TagKeys": ["Application"], "aws:RequestTag/Application": "AdmitFlow" },
    asymmetric: { "kms:KeySpec": "RSA_2048" }, signing: { "kms:KeyUsage": "SIGN_VERIFY" },
    imported: { "kms:KeyOrigin": "EXTERNAL" }, cloudhsm: { "kms:KeyOrigin": "AWS_CLOUDHSM" },
    multiregion: { "kms:MultiRegion": "true" }, region: { "aws:RequestedRegion": "us-east-1" },
  })) add(`bootstrap-create-reject-${name}`, "tenant-key-create", "bootstrap", "kms:CreateKey", "*", "implicitDeny", { ...createContext, ...context });
  add("bootstrap-create-reject-missing-key-context", "tenant-key-create", "bootstrap", "kms:CreateKey", "*", "implicitDeny");
  add("bootstrap-create-reject-lockout-bypass", "tenant-key-create", "bootstrap", "kms:CreateKey", "*", "explicitDeny", { ...createContext, "kms:BypassPolicyLockoutSafetyCheck": "true" });
  for (const action of ["kms:TagResource", "kms:PutKeyPolicy", "kms:CreateAlias", "kms:EnableKeyRotation", "kms:Decrypt"]) {
    add(`creation-no-iam-${action}`, "tenant-key-create", "bootstrap", action, key, "implicitDeny", requestTags);
  }
  const tagContext = { ...requestTags, "aws:TagKeys": ["Application", "Environment"] };
  add("configure-tag-exact-new-key", "tenant-key-configure", "bootstrap", "kms:TagResource", key, "allowed", tagContext);
  add("configure-cannot-relabel-other-key", "tenant-key-configure", "bootstrap", "kms:TagResource", otherKey, "implicitDeny", { ...tagContext, ...resourceTags });
  add("configure-reject-extra-tags", "tenant-key-configure", "bootstrap", "kms:TagResource", key, "implicitDeny", { ...tagContext, "aws:TagKeys": ["Application", "Environment", "Other"] });
  add("configure-reject-wrong-tag", "tenant-key-configure", "bootstrap", "kms:TagResource", key, "implicitDeny", { ...tagContext, "aws:RequestTag/Application": "Other" });
  add("configure-reject-missing-tag-keys", "tenant-key-configure", "bootstrap", "kms:TagResource", key, "implicitDeny", requestTags);
  for (const action of ["kms:DescribeKey", "kms:GetKeyPolicy", "kms:ListResourceTags", "kms:EnableKeyRotation", "kms:GetKeyRotationStatus", "kms:PutKeyPolicy", "kms:CreateAlias"]) {
    add(`configure-exact-${action}`, "tenant-key-configure", "bootstrap", action, key, "allowed");
    add(`configure-no-other-${action}`, "tenant-key-configure", "bootstrap", action, otherKey, "implicitDeny");
    add(`configure-no-other-region-${action}`, "tenant-key-configure", "bootstrap", action, key, "implicitDeny", { "aws:RequestedRegion": "us-east-1" });
  }
  add("configure-no-policy-lockout-bypass", "tenant-key-configure", "bootstrap", "kms:PutKeyPolicy", key, "explicitDeny", { "kms:BypassPolicyLockoutSafetyCheck": "true" });
  add("configure-exact-alias", "tenant-key-configure", "bootstrap", "kms:CreateAlias", alias, "allowed");
  add("configure-no-other-alias", "tenant-key-configure", "bootstrap", "kms:CreateAlias", `${alias}-other`, "implicitDeny");
  for (const action of ["kms:UpdateAlias", "kms:DeleteAlias", "kms:ScheduleKeyDeletion", "kms:DisableKey", "kms:CreateGrant", "kms:Decrypt"]) {
    for (const resource of [key, alias]) add(`configure-no-${action}-${resource === key ? "key" : "alias"}`, "tenant-key-configure", "bootstrap", action, resource, "implicitDeny");
  }
  add("configure-no-more-keys", "tenant-key-configure", "bootstrap", "kms:CreateKey", "*", "implicitDeny", createContext);
  add("bootstrap-regional-alias-metadata", "tenant-key-configure", "bootstrap", "kms:ListAliases", "*", "allowed");
  add("bootstrap-no-other-region-alias-metadata", "tenant-key-configure", "bootstrap", "kms:ListAliases", "*", "implicitDeny", { "aws:RequestedRegion": "us-east-1" });
  for (const identity of ["cloudformation", "deploy", "publisher"]) {
    for (const action of ["kms:TagResource", "kms:PutKeyPolicy", "kms:EnableKeyRotation", "kms:ScheduleKeyDeletion", "kms:CreateGrant"]) {
      add(`${identity}-no-routine-${action}`, "deployment", identity, action, key, "implicitDeny", { ...tagContext, ...resourceTags });
    }
    for (const action of ["kms:CreateKey", "kms:ListAliases"]) add(`${identity}-no-routine-${action}`, "deployment", identity, action, "*", "implicitDeny", createContext);
    for (const action of ["kms:CreateAlias", "kms:UpdateAlias", "kms:DeleteAlias"]) add(`${identity}-no-routine-${action}`, "deployment", identity, action, alias, "implicitDeny");
  }
  for (const workload of ["web", "worker"]) {
    const boundary = `admitflow-prod-${workload}-task-boundary.json`;
    add(`${workload}-exact-key-crypto`, "deployment", boundary, "kms:Decrypt", key, "allowed");
    add(`${workload}-no-other-tagged-key-crypto`, "deployment", boundary, "kms:Decrypt", otherKey, "implicitDeny", resourceTags);
    add(`${workload}-no-key-admin`, "deployment", boundary, "kms:PutKeyPolicy", key, "implicitDeny");
  }
  add("migration-task-denies-all", "deployment", "admitflow-prod-migration-task-boundary.json", "secretsmanager:GetSecretValue", input.applicationSecretArn, "explicitDeny");
  add("migration-execution-whole-json-limit", "deployment", "admitflow-prod-migration-execution-boundary.json", "secretsmanager:GetSecretValue", input.applicationSecretArn, "allowed");
  add("web-execution-cannot-read-worker-logs", "deployment", "admitflow-prod-web-execution-boundary.json", "logs:PutLogEvents", ar("logs", "log-group:/admitflow/prod/worker:log-stream:worker/test"), "implicitDeny");
  add("execution-cannot-read-unrelated-secret", "deployment", "admitflow-prod-web-execution-boundary.json", "secretsmanager:GetSecretValue", ar("secretsmanager", "secret:unrelated-AbCd12"), "implicitDeny");
  const certificateContext = { ...requestTags, "acm:DomainNames": [CONTRACT.domain], "acm:ValidationMethod": "DNS", "acm:KeyAlgorithm": "RSA_2048" };
  add("request-exact-cert", "prerequisites", "bootstrap", "acm:RequestCertificate", "*", "allowed", certificateContext);
  add("request-extra-san", "prerequisites", "bootstrap", "acm:RequestCertificate", "*", "implicitDeny", { ...certificateContext, "acm:DomainNames": [CONTRACT.domain, "incfrog.ai"] });
  add("request-email-validation", "prerequisites", "bootstrap", "acm:RequestCertificate", "*", "implicitDeny", { ...certificateContext, "acm:ValidationMethod": "EMAIL" });
  const zone = `arn:aws:route53:::hostedzone/${CONTRACT.hostedZoneId}`;
  const dnsContext = { "route53:ChangeResourceRecordSetsNormalizedRecordNames": [input.validationRecordName], "route53:ChangeResourceRecordSetsRecordTypes": ["CNAME"], "route53:ChangeResourceRecordSetsActions": ["CREATE"] };
  add("actual-validation-name", "dns-validation", "bootstrap", "route53:ChangeResourceRecordSets", zone, "allowed", dnsContext);
  add("wrong-zone", "dns-validation", "bootstrap", "route53:ChangeResourceRecordSets", "arn:aws:route53:::hostedzone/ZOTHER", "implicitDeny", dnsContext);
  for (const action of ["UPSERT", "DELETE"]) add(`dns-no-${action}`, "dns-validation", "bootstrap", "route53:ChangeResourceRecordSets", zone, "implicitDeny", { ...dnsContext, "route53:ChangeResourceRecordSetsActions": [action] });
  add("dns-no-apex", "dns-validation", "bootstrap", "route53:ChangeResourceRecordSets", zone, "implicitDeny", { ...dnsContext, "route53:ChangeResourceRecordSetsNormalizedRecordNames": [input.validationRecordName, "incfrog.ai"] });
  add("dns-no-missing-context", "dns-validation", "bootstrap", "route53:ChangeResourceRecordSets", zone, "implicitDeny");
  const appContext = { ...dnsContext, "route53:ChangeResourceRecordSetsNormalizedRecordNames": [CONTRACT.domain], "route53:ChangeResourceRecordSetsRecordTypes": ["A"] };
  add("application-a", "dns-application", "bootstrap", "route53:ChangeResourceRecordSets", zone, "allowed", appContext);
  add("no-aaaa", "dns-application", "bootstrap", "route53:ChangeResourceRecordSets", zone, "implicitDeny", { ...appContext, "route53:ChangeResourceRecordSetsRecordTypes": ["AAAA"] });
  const migrationContext = { "ecs:cluster": ar("ecs", "cluster/admitflow-prod"), "ecs:enable-execute-command": "false" };
  add("migration-run", "release-operator", "release-operator", "ecs:RunTask", input.migrationTaskDefinitionArn, "allowed", migrationContext);
  add("migration-wrong-cluster", "release-operator", "release-operator", "ecs:RunTask", input.migrationTaskDefinitionArn, "implicitDeny", { ...migrationContext, "ecs:cluster": ar("ecs", "cluster/other") });
  add("migration-no-exec", "release-operator", "release-operator", "ecs:RunTask", input.migrationTaskDefinitionArn, "implicitDeny", { ...migrationContext, "ecs:enable-execute-command": "true" });
  add("migration-no-web", "release-operator", "release-operator", "ecs:RunTask", input.migrationTaskDefinitionArn.replace("-migration:", "-web:"), "implicitDeny", migrationContext);
  add("migration-no-other-revision", "release-operator", "release-operator", "ecs:RunTask", `${input.migrationTaskDefinitionArn}0`, "implicitDeny", migrationContext);
  add("migration-pass-task", "release-operator", "release-operator", "iam:PassRole", WORKLOAD_ROLES.find(role => role.name === "admitflow-prod-migration-task").arn, "allowed", { "iam:PassedToService": "ecs-tasks.amazonaws.com" });
  add("migration-no-pass-web", "release-operator", "release-operator", "iam:PassRole", WORKLOAD_ROLES[0].arn, "implicitDeny", { "iam:PassedToService": "ecs-tasks.amazonaws.com" });
  return cases;
}
export function policiesFor(bundle, identity) {
  const names = bundle.attachments[identity] ?? (bundle.policies[identity] ? [identity] : []);
  if (!names.length) throw new Error("Unknown policy identity");
  return names.map(name => bundle.policies[name]);
}
/** Export parameters only. Never calls IAM. Use real verified input for AWS validation, not test fixture IDs. */
export function simulationInputs(input) {
  return validationCases(input).map(test => ({ id: test.id, expected: test.expected, phase: test.phase, identity: test.identity, input: {
    PolicyInputList: policiesFor(generate(test.phase, input), test.identity).map(policy => JSON.stringify(policy)),
    ActionNames: [test.action], ResourceArns: [test.resource],
    ContextEntries: Object.entries(test.context).filter(([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0)).map(([ContextKeyName, value]) => ({ ContextKeyName, ContextKeyValues: Array.isArray(value) ? value : [value], ContextKeyType: Array.isArray(value) ? "stringList" : ["ecs:enable-execute-command", "aws:MultiFactorAuthPresent", "kms:MultiRegion", "kms:BypassPolicyLockoutSafetyCheck"].includes(ContextKeyName) ? "boolean" : "string" })),
  } }));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--help") console.log("Offline export only: node infra/iam/validation.mjs <verified-identifier-input.json> <new-output-directory>. Produces AWS SimulateCustomPolicy input JSON, not validation results.");
    else {
      if (args.length !== 2) throw new Error("Expected identifier input and new output directory");
      const cases = simulationInputs(JSON.parse(readFileSync(resolve(args[0]), "utf8")));
      const output = resolve(args[1]); if (existsSync(output)) throw new Error("Output directory must not already exist");
      mkdirSync(output, { recursive: true });
      for (const [index, test] of cases.entries()) writeFileSync(join(output, `case-${index + 1}.json`), `${JSON.stringify(test.input, null, 2)}\n`, { flag: "wx" });
      writeFileSync(join(output, "cases.json"), `${JSON.stringify(cases.map(({ input: ignored, ...metadata }, index) => ({ ...metadata, file: `case-${index + 1}.json` })), null, 2)}\n`, { flag: "wx" });
      console.log("AWS simulation inputs exported offline; no simulation was executed.");
    }
  } catch (error) { console.error(error instanceof SyntaxError ? "Invalid identifier JSON" : error.message); process.exitCode = 1; }
}
