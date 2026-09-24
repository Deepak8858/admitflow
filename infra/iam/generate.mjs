import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

export const CONTRACT = Object.freeze({
  account: "543777713748", region: "ap-southeast-1", stack: "AdmitFlow-prod",
  domain: "admitflow.incfrog.ai", hostedZoneId: "Z07524403BCACLCZ72JOD",
  githubRepository: "Deepak8858/admitflow",
  operatorArn: "arn:aws:iam::543777713748:user/admitflow/admitflow-deployer",
  deployRoleArn: "arn:aws:iam::543777713748:role/admitflow/deployment/admitflow-prod-deploy",
  cfnRoleArn: "arn:aws:iam::543777713748:role/admitflow/deployment/admitflow-prod-cfn-exec",
  bootstrapRoleArn: "arn:aws:iam::543777713748:role/admitflow/bootstrap/admitflow-prod-bootstrap",
});
const { account, region } = CONTRACT;
const arn = (service, resource) => `arn:aws:${service}:${region}:${account}:${resource}`;
export const CACHE_PARAMETERS = Object.freeze({
  name: "admitflow-prod-queue-valkey7-v1",
  arn: arn("elasticache", "parametergroup:admitflow-prod-queue-valkey7-v1"),
  family: "valkey7",
});
const iam = resource => `arn:aws:iam::${account}:${resource}`;
const roles = ["web", "worker", "migration"].flatMap(service => ["task", "execution"].map(kind => ({
  service, kind, name: `admitflow-prod-${service}-${kind}`,
  arn: iam(`role/admitflow/workload/prod/admitflow-prod-${service}-${kind}`),
  boundaryArn: iam(`policy/admitflow/boundaries/prod/admitflow-prod-${service}-${kind}-boundary`),
})));
export const WORKLOAD_ROLES = Object.freeze(roles);
const regional = { StringEquals: { "aws:RequestedRegion": region } };
const tags = kind => ({ StringEquals: { [`aws:${kind}Tag/Application`]: "AdmitFlow", [`aws:${kind}Tag/Environment`]: "prod" } });
const merge = (...conditions) => conditions.reduce((result, condition) => {
  for (const [operator, entries] of Object.entries(condition)) result[operator] = { ...result[operator], ...entries };
  return result;
}, {});
const list = value => Array.isArray(value) ? value : [value];
const statement = (Sid, Action, Resource, Condition = {}, Effect = "Allow") => ({
  Sid, Effect, Action: list(Action), Resource: list(Resource),
  ...(Object.keys(Condition).length ? { Condition } : {}),
});
const allow = (id, actions, resources, conditions = {}) => statement(id, actions, resources, merge(regional, conditions));
const document = Statement => ({ Version: "2012-10-17", Statement });
const resourceTags = tags("Resource"), requestTags = tags("Request");
const ecr = arn("ecr", "repository/admitflow-prod");
const cluster = arn("ecs", "cluster/admitflow-prod");
const services = ["web", "worker"].map(name => arn("ecs", `service/admitflow-prod/admitflow-prod-${name}`));
const taskDefinitions = ["web", "worker", "migration"].map(name => arn("ecs", `task-definition/admitflow-prod-${name}:*`));
const queueSecret = arn("secretsmanager", "secret:admitflow/prod/queue-auth-??????");
const applicationSecret = arn("secretsmanager", "secret:admitflow/prod/application-??????");
const tenantAlias = arn("kms", "alias/admitflow-prod-tenant-credentials");
const keyIdPattern = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const stack = arn("cloudformation", `stack/${CONTRACT.stack}/*`);
const alb = arn("elasticloadbalancing", "loadbalancer/app/admitflow-prod-alb/*");
const listeners = arn("elasticloadbalancing", "listener/app/admitflow-prod-alb/*/*");
const rules = arn("elasticloadbalancing", "listener-rule/app/admitflow-prod-alb/*/*/*");
const target = arn("elasticloadbalancing", "targetgroup/admitflow-prod-web/*");
const logNames = ["/admitflow/prod/web", "/admitflow/prod/worker", "/admitflow/prod/migration", "/aws/vendedlogs/admitflow/prod/valkey"];
const logArns = logNames.map(name => arn("logs", `log-group:${name}`));
const logApiArns = logArns.map(value => `${value}:*`);
const zoneArn = `arn:aws:route53:::hostedzone/${CONTRACT.hostedZoneId}`;
const fixedKeys = Object.keys(CONTRACT);
const extraKeys = ["applicationSecretArn", "applicationSecretKeyMode", "applicationSecretKmsKeyArn", "tenantKeyArn", "cacheParameterGroupArn", "queueSecretArn", "certificateArn", "validationRecordName", "loadBalancerArn", "targetGroupArn", "migrationTaskDefinitionArn"];
function requireValue(input, key, expression) {
  const value = input[key];
  if (typeof value !== "string" || value.trim() !== value || !expression.test(value)) throw new Error(`Missing or invalid verified identifier: ${key}`);
  return value;
}
const exactArn = (service, suffix) => new RegExp(`^arn:aws:${service}:${region}:${account}:${suffix}$`);
function common(input) {
  if (!input || Array.isArray(input) || typeof input !== "object") throw new Error("Input must be an identifier-only object");
  for (const key of Object.keys(input)) if (![...fixedKeys, ...extraKeys].includes(key)) throw new Error("Unexpected input field; never provide secret values");
  for (const key of fixedKeys) if (input[key] !== CONTRACT[key]) throw new Error(`Missing or mismatched contract: ${key}`);
  if (input.tenantKeyArn !== undefined) tenantKey(input);
  if (input.cacheParameterGroupArn !== undefined) cacheParameters(input);
  if (input.queueSecretArn !== undefined) requireValue(input, "queueSecretArn", exactArn("secretsmanager", "secret:admitflow/prod/queue-auth-[A-Za-z0-9]{6}"));
}
function application(input) {
  requireValue(input, "applicationSecretArn", exactArn("secretsmanager", "secret:admitflow/prod/application-[A-Za-z0-9]{6}"));
  if (!["aws-managed", "customer-managed"].includes(input.applicationSecretKeyMode)) throw new Error("Select applicationSecretKeyMode explicitly");
  if (input.applicationSecretKeyMode === "customer-managed") requireValue(input, "applicationSecretKmsKeyArn", exactArn("kms", "key/[a-f0-9-]{36}"));
  else if (input.applicationSecretKmsKeyArn !== undefined) throw new Error("AWS-managed key mode cannot include a customer key ARN");
}
const tenantKey = input => requireValue(input, "tenantKeyArn", exactArn("kms", `key/${keyIdPattern}`));
function cacheParameters(input) {
  if (input.cacheParameterGroupArn !== CACHE_PARAMETERS.arn) throw new Error("Missing or invalid verified identifier: cacheParameterGroupArn");
  return input.cacheParameterGroupArn;
}
const certificate = input => requireValue(input, "certificateArn", exactArn("acm", "certificate/[a-f0-9-]{36}"));
/** Resource '*' in a key policy means only the key to which that policy is attached. */
function tenantKeyPolicy(temporaryBootstrapGrant) {
  return document([
    { Sid: "EnableAccountIamDelegation", Effect: "Allow", Principal: { AWS: iam("root") }, Action: "kms:*", Resource: "*" },
    ...(temporaryBootstrapGrant ? [{
      Sid: "TemporaryBootstrapPolicyUpdate", Effect: "Allow", Principal: { AWS: CONTRACT.bootstrapRoleArn },
      Action: "kms:PutKeyPolicy", Resource: "*", Condition: { Bool: { "kms:BypassPolicyLockoutSafetyCheck": "false" } },
    }] : []),
  ]);
}
const userTrust = () => document([{
  Sid: "ExactOperatorWithMfa", Effect: "Allow", Principal: { AWS: CONTRACT.operatorArn }, Action: "sts:AssumeRole",
  Condition: { Bool: { "aws:MultiFactorAuthPresent": "true" } },
}]);
const cfnTrust = () => document([{ Effect: "Allow", Principal: { Service: "cloudformation.amazonaws.com" }, Action: "sts:AssumeRole" }]);
const taskTrust = () => document([{
  Effect: "Allow", Principal: { Service: "ecs-tasks.amazonaws.com" }, Action: "sts:AssumeRole",
  Condition: { StringEquals: { "aws:SourceAccount": account }, ArnLike: { "aws:SourceArn": arn("ecs", "*") } },
}]);
const publisherTrust = () => document([{
  Effect: "Allow", Principal: { Federated: iam("oidc-provider/token.actions.githubusercontent.com") }, Action: "sts:AssumeRoleWithWebIdentity",
  Condition: { StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com", "token.actions.githubusercontent.com:sub": `repo:${CONTRACT.githubRepository}:ref:refs/heads/main` } },
}]);

/** Split at statement boundaries; each output is one customer-managed policy, NOT an inline policy. */
export function splitManagedPolicies(statements, maxSize = 6144) {
  const parts = []; let current = [];
  for (const item of statements) {
    if (JSON.stringify(document([item])).length > maxSize) throw new Error("A policy statement exceeds the managed-policy quota");
    if (JSON.stringify(document([...current, item])).length > maxSize) { parts.push(document(current)); current = []; }
    current.push(item);
  }
  if (current.length) parts.push(document(current));
  return parts;
}
function addFamily(bundle, identity, family, statements) {
  for (const [index, policy] of splitManagedPolicies(statements).entries()) {
    const filename = `${identity}-${family}-${index + 1}.json`;
    bundle.policies[filename] = policy;
    (bundle.attachments[identity] ??= []).push(filename);
  }
}
function finish(bundle) {
  for (const [identity, files] of Object.entries(bundle.attachments)) if (files.length > 10) throw new Error(`Default 10 managed-policy attachments exceeded for ${identity}`);
  for (const trust of Object.values(bundle.trust)) if (JSON.stringify(trust).length > 2048) throw new Error("Default trust policy quota exceeded");
  bundle.sizes = Object.fromEntries(Object.entries(bundle.policies).map(([name, policy]) => [name, JSON.stringify(policy).length]));
  return bundle;
}
function empty(phase) {
  return { schemaVersion: 1, phase, contract: CONTRACT, policies: {}, trust: {}, attachments: {}, boundaries: {}, resourcePolicies: {}, requests: {}, validation: { status: "OFFLINE_CANDIDATE_NOT_AWS_VALIDATED", required: ["IAM Access Analyzer ValidatePolicy", "AWS IAM simulation including missing context", "CloudFormation resource-provider dependent actions and tag propagation", "Trust/MFA login-flow verification", "Independent review and explicit resource-change approval"] } };
}
function bootstrapTrust(bundle) {
  bundle.trust["bootstrap"] = userTrust();
  addFamily(bundle, "operator", "assume-bootstrap", [statement("AssumeBootstrapOnlyWithMfa", "sts:AssumeRole", CONTRACT.bootstrapRoleArn, { Bool: { "aws:MultiFactorAuthPresent": "true" } })]);
}
function bootstrapMetadata() {
  return [statement("ExactPublicZoneInventory", ["route53:GetHostedZone", "route53:ListResourceRecordSets"], zoneArn), statement("WaitForChange", "route53:GetChange", "arn:aws:route53:::change/*")];
}

export function generate(phase, input) {
  common(input);
  const bundle = empty(phase);
  if (phase === "prerequisites") {
    bootstrapTrust(bundle);
    addFamily(bundle, "bootstrap", "certificate-inventory", [allow("RegionalCertificateInventoryException", "acm:ListCertificates", "*")]);
    addFamily(bundle, "bootstrap", "certificate-request", [allow("ExactDomainDnsCertificate", "acm:RequestCertificate", "*", merge(requestTags, {
      "ForAllValues:StringEquals": { "acm:DomainNames": [CONTRACT.domain] },
      StringEquals: { "acm:ValidationMethod": "DNS", "acm:KeyAlgorithm": "RSA_2048" },
      Null: { "acm:DomainNames": "false", "acm:CertificateAuthority": "true" },
    })), allow("TagOnlyApplicationCertificate", "acm:AddTagsToCertificate", arn("acm", "certificate/*"), merge(requestTags, resourceTags))]);
    addFamily(bundle, "bootstrap", "create-application-secret", [allow("CreateExactApplicationSecret", "secretsmanager:CreateSecret", applicationSecret, merge(requestTags, {
      StringEquals: { "secretsmanager:Name": "admitflow/prod/application" },
      Null: { "secretsmanager:AddReplicaRegions": "true", "secretsmanager:KmsKeyId": "true" },
    })), allow("TagExactApplicationSecret", "secretsmanager:TagResource", applicationSecret, requestTags)]);
    addFamily(bundle, "bootstrap", "oneoff-log-policy", [allow("OneOffAccountLogPolicyWrite", ["logs:PutResourcePolicy", "logs:DescribeResourcePolicies"], "*")]);
    bundle.resourcePolicies["valkey-log-delivery.json"] = document([{
      Effect: "Allow", Principal: { Service: "delivery.logs.amazonaws.com" }, Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: `${logArns[3]}:*`,
      Condition: { StringEquals: { "aws:SourceAccount": account }, ArnLike: { "aws:SourceArn": arn("logs", "*") } },
    }]);
    // Service-linked roles are bootstrap prerequisites, not arbitrary workload IAM creation.
    addFamily(bundle, "bootstrap", "service-linked-roles", [
      ["ecs.amazonaws.com", "AWSServiceRoleForECS"], ["elasticloadbalancing.amazonaws.com", "AWSServiceRoleForElasticLoadBalancing"], ["elasticache.amazonaws.com", "AWSServiceRoleForElastiCache"],
    ].map(([service, name], index) => statement(`CreateServiceLinkedRole${index}`, "iam:CreateServiceLinkedRole", iam(`role/aws-service-role/${service}/${name}`), { StringEquals: { "iam:AWSServiceName": service } })));
    addFamily(bundle, "bootstrap", "dns-inventory", bootstrapMetadata());
  } else if (phase === "cache-parameters-create" || phase === "cache-parameters-configure") {
    const creating = phase === "cache-parameters-create";
    const parameters = creating ? CACHE_PARAMETERS.arn : cacheParameters(input);
    bootstrapTrust(bundle);
    const tagConditions = merge(requestTags, {
      "ForAllValues:StringEquals": { "aws:TagKeys": ["Application", "Environment"] },
      Null: { "aws:TagKeys": "false" },
    });
    addFamily(bundle, "bootstrap", phase, [
      allow("ReadExactCacheParameters", ["elasticache:DescribeCacheParameterGroups", "elasticache:DescribeCacheParameters", "elasticache:ListTagsForResource"], parameters),
      ...(creating ? [
        allow("CreateExactTaggedCacheParameters", "elasticache:CreateCacheParameterGroup", parameters, tagConditions),
        // Exact ARN plus request tags: existing resource tags cannot be required at creation.
        // This also permits tagging an existing exact-name group; preflight conflicts must stop.
        allow("TagExactCacheParametersAtCreation", "elasticache:AddTagsToResource", parameters, tagConditions),
      ] : [allow("ConfigureExactTaggedCacheParameters", "elasticache:ModifyCacheParameterGroup", parameters, resourceTags)]),
    ]);
    bundle.requests[creating ? "create-cache-parameter-group.json" : "modify-cache-parameter-group.json"] = creating ? {
      CacheParameterGroupName: CACHE_PARAMETERS.name, CacheParameterGroupFamily: CACHE_PARAMETERS.family,
      Description: "BullMQ requires noeviction on node-based Valkey",
      Tags: [{ Key: "Application", Value: "AdmitFlow" }, { Key: "Environment", Value: "prod" }],
    } : {
      CacheParameterGroupName: CACHE_PARAMETERS.name,
      ParameterNameValues: [{ ParameterName: "maxmemory-policy", ParameterValue: "noeviction" }],
    };
    bundle.validation.required.push("Separately approve live execution and cleanup. Inventory exact name before creation; stop on conflicts and reconcile uncertain writes without blind retries. Creation tagging can relabel an existing exact-name group; IAM does not constrain family/description/parameter payloads. Replace creation with configuration authority, verify actual ARN/family/tags/noeviction, then detach setup permissions. External group survives stack rollback/deletion and needs readback before every deployment. No deletion or automatic recovery is authorized.");
  } else if (phase === "tenant-key-create") {
    bootstrapTrust(bundle);
    addFamily(bundle, "bootstrap", "tenant-key-create", [
      allow("CreateUntaggedTenantKey", "kms:CreateKey", "*", {
        StringEquals: { "kms:KeySpec": "SYMMETRIC_DEFAULT", "kms:KeyUsage": "ENCRYPT_DECRYPT", "kms:KeyOrigin": "AWS_KMS" },
        Bool: { "kms:MultiRegion": "false" }, Null: { "aws:TagKeys": "true" },
      }),
      statement("NeverBypassKeyPolicySafety", ["kms:CreateKey", "kms:PutKeyPolicy"], "*", { Bool: { "kms:BypassPolicyLockoutSafetyCheck": "true" } }, "Deny"),
    ]);
    bundle.resourcePolicies["tenant-key-initial.json"] = tenantKeyPolicy(true);
    bundle.requests["create-key.json"] = {
      Description: "AdmitFlow tenant-bound provider credential encryption", KeySpec: "SYMMETRIC_DEFAULT",
      KeyUsage: "ENCRYPT_DECRYPT", Origin: "AWS_KMS", MultiRegion: false, BypassPolicyLockoutSafetyCheck: false,
      Policy: JSON.stringify(bundle.resourcePolicies["tenant-key-initial.json"]),
    };
    bundle.validation.required.push("CreateKey is non-idempotent: disable retries, capture actual returned ARN, stop on uncertainty. Review initial policy; arbitrary policy contents and key quantity cannot be constrained by this permission.");
  } else if (phase === "tenant-key-configure") {
    const key = tenantKey(input); bootstrapTrust(bundle);
    addFamily(bundle, "bootstrap", "tenant-key-configure", [
      allow("ReadExactTenantKey", ["kms:DescribeKey", "kms:GetKeyPolicy", "kms:GetKeyRotationStatus", "kms:ListResourceTags"], key),
      allow("TagExactTenantKey", "kms:TagResource", key, merge(requestTags, {
        "ForAllValues:StringEquals": { "aws:TagKeys": ["Application", "Environment"] }, Null: { "aws:TagKeys": "false" },
      })),
      allow("EnableExactTenantKeyRotation", "kms:EnableKeyRotation", key),
      allow("FinalizeExactTenantKeyPolicy", "kms:PutKeyPolicy", key),
      statement("NeverBypassKeyPolicySafety", "kms:PutKeyPolicy", key, { Bool: { "kms:BypassPolicyLockoutSafetyCheck": "true" } }, "Deny"),
      allow("CreateOnlyTenantAlias", "kms:CreateAlias", tenantAlias),
      allow("AliasOnlyExactTenantKey", "kms:CreateAlias", key),
      allow("ReadRegionalKmsAliasesException", "kms:ListAliases", "*"),
    ]);
    bundle.resourcePolicies["tenant-key-final.json"] = tenantKeyPolicy(false);
    bundle.requests["tag-resource.json"] = { KeyId: key, Tags: [{ TagKey: "Application", TagValue: "AdmitFlow" }, { TagKey: "Environment", TagValue: "prod" }] };
    bundle.requests["enable-key-rotation.json"] = { KeyId: key };
    bundle.requests["create-alias.json"] = { AliasName: "alias/admitflow-prod-tenant-credentials", TargetKeyId: key };
    bundle.requests["put-key-policy.json"] = { KeyId: key, PolicyName: "default", BypassPolicyLockoutSafetyCheck: false, Policy: JSON.stringify(bundle.resourcePolicies["tenant-key-final.json"]) };
    bundle.validation.required.push("Replace creation permissions, not union them. Verify actual key provenance, tags, rotation and exact alias; remove temporary direct bootstrap key-policy grant with exact-key IAM permission still attached, verify final readback, then detach setup permissions. These request files are not an executable workflow.");
  } else if (phase === "certificate-metadata") {
    certificate(input); bootstrapTrust(bundle);
    addFamily(bundle, "bootstrap", "certificate-metadata", [allow("ActualCertificateMetadata", "acm:DescribeCertificate", input.certificateArn)]);
  } else if (phase === "secret-update") {
    application(input); bootstrapTrust(bundle);
    addFamily(bundle, "bootstrap", "existing-secret", [allow("PopulateExistingApplicationSecret", ["secretsmanager:PutSecretValue", "secretsmanager:DescribeSecret"], input.applicationSecretArn),
      ...(input.applicationSecretKmsKeyArn ? [allow("ExistingSecretKeyOnly", ["kms:Decrypt", "kms:GenerateDataKey"], input.applicationSecretKmsKeyArn, { StringEquals: { "kms:ViaService": `secretsmanager.${region}.amazonaws.com`, "kms:EncryptionContext:SecretARN": input.applicationSecretArn } })] : []),
    ]);
  } else if (phase === "dns-validation" || phase === "dns-application") {
    certificate(input); bootstrapTrust(bundle);
    const validation = phase === "dns-validation";
    const name = validation ? requireValue(input, "validationRecordName", /^_[a-f0-9]{32}\.admitflow\.incfrog\.ai$/) : CONTRACT.domain;
    if (!validation) {
      requireValue(input, "loadBalancerArn", exactArn("elasticloadbalancing", "loadbalancer/app/admitflow-prod-alb/[a-f0-9]{16}"));
      requireValue(input, "targetGroupArn", exactArn("elasticloadbalancing", "targetgroup/admitflow-prod-web/[a-f0-9]{16}"));
    }
    addFamily(bundle, "bootstrap", "dns", [...bootstrapMetadata(), statement("CreateOnlyReviewedRecord", "route53:ChangeResourceRecordSets", zoneArn, {
      "ForAllValues:StringEquals": { "route53:ChangeResourceRecordSetsNormalizedRecordNames": [name], "route53:ChangeResourceRecordSetsRecordTypes": [validation ? "CNAME" : "A"], "route53:ChangeResourceRecordSetsActions": ["CREATE"] },
      Null: Object.fromEntries(["NormalizedRecordNames", "RecordTypes", "Actions"].map(key => [`route53:ChangeResourceRecordSets${key}`, "false"])),
    }), allow("ActualCertificateMetadata", "acm:DescribeCertificate", input.certificateArn),
    ...(!validation ? [allow("RegionalAlbReadException", ["elasticloadbalancing:DescribeLoadBalancers", "elasticloadbalancing:DescribeTargetGroups", "elasticloadbalancing:DescribeTargetHealth", "elasticloadbalancing:DescribeListeners"], "*"), allow("ExactServicesRead", "ecs:DescribeServices", services)] : []),
    ]);
  } else if (phase === "release-operator") {
    requireValue(input, "migrationTaskDefinitionArn", exactArn("ecs", "task-definition/admitflow-prod-migration:[1-9][0-9]*"));
    // Review-only family. No trust or role attachment target is assigned automatically.
    addFamily(bundle, "release-operator", "migration", [
      allow("RunOnlyVerifiedMigrationRevision", "ecs:RunTask", input.migrationTaskDefinitionArn, { ArnEquals: { "ecs:cluster": cluster }, Bool: { "ecs:enable-execute-command": "false" } }),
      statement("PassOnlyMigrationRoles", "iam:PassRole", roles.filter(role => role.service === "migration").map(role => role.arn), { StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } }),
      allow("ReadTasksInApplicationCluster", "ecs:DescribeTasks", arn("ecs", "task/admitflow-prod/*"), { ArnEquals: { "ecs:cluster": cluster } }),
      allow("ReadMigrationLogEvents", "logs:GetLogEvents", `${logArns[2]}:log-stream:*`),
      allow("ReadMigrationLogs", ["logs:FilterLogEvents", "logs:DescribeLogStreams"], `${logArns[2]}:*`),
    ]);
    bundle.validation.required.push("Choose reviewed non-root attachment identity; migration revision/digest and network review. Service count changes remain CloudFormation operations, not direct UpdateService.");
  } else if (phase === "deployment") {
    application(input); certificate(input); tenantKey(input); cacheParameters(input);
    deployment(bundle, input);
  } else throw new Error("Unknown phase");
  return finish(bundle);
}

function deployment(bundle, input) {
  const queue = input.queueSecretArn ?? queueSecret;
  const key = input.tenantKeyArn;
  bundle.trust.deploy = userTrust(); bundle.trust.cloudformation = cfnTrust(); bundle.trust.publisher = publisherTrust();
  bundle.trust.workload = taskTrust();
  addFamily(bundle, "operator", "assume-deploy", [statement("AssumeDeployOnlyWithMfa", "sts:AssumeRole", CONTRACT.deployRoleArn, { Bool: { "aws:MultiFactorAuthPresent": "true" } })]);
  addFamily(bundle, "deploy", "cloudformation", [
    allow("ChangeOnlyApplicationStack", ["cloudformation:CreateStack", "cloudformation:UpdateStack", "cloudformation:CreateChangeSet", "cloudformation:DeleteStack", "cloudformation:ContinueUpdateRollback"], stack, { StringEquals: { "cloudformation:RoleArn": CONTRACT.cfnRoleArn } }),
    allow("OperateOnlyApplicationStack", ["cloudformation:ExecuteChangeSet", "cloudformation:DeleteChangeSet", "cloudformation:DescribeChangeSet", "cloudformation:DescribeStacks", "cloudformation:DescribeStackEvents", "cloudformation:DescribeStackResources", "cloudformation:DescribeStackResource", "cloudformation:ListStackResources", "cloudformation:ListChangeSets", "cloudformation:GetTemplate", "cloudformation:GetTemplateSummary", "cloudformation:GetStackPolicy", "cloudformation:CancelUpdateStack", "cloudformation:TagResource", "cloudformation:UntagResource"], stack),
    statement("PassOnlyCloudFormationExecutionRole", "iam:PassRole", CONTRACT.cfnRoleArn, { StringEquals: { "iam:PassedToService": "cloudformation.amazonaws.com" } }),
  ]);
  addFamily(bundle, "publisher", "ecr-push", [allow("EcrAuthorizationTokenRegionalException", "ecr:GetAuthorizationToken", "*"), allow("PublishOnlyApplicationRepository", ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage", "ecr:DescribeImages", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage"], ecr)]);
  for (const role of roles) {
    const permissions = role.kind === "task" ? (role.service === "migration" ? [statement("NoAwsPermissions", "*", "*", {}, "Deny")] : [allow("TenantCredentialCryptography", ["kms:Encrypt", "kms:Decrypt", "kms:ReEncryptFrom", "kms:ReEncryptTo", "kms:GenerateDataKey", "kms:GenerateDataKeyWithoutPlaintext", "kms:DescribeKey"], key)]) : [
      allow("EcrTokenRegionalException", "ecr:GetAuthorizationToken", "*"),
      allow("PullOnlyApplicationImages", ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"], ecr),
      allow("WriteOnlyOwnLogStreams", ["logs:CreateLogStream", "logs:PutLogEvents"], arn("logs", `log-group:/admitflow/prod/${role.service}:log-stream:*`)),
      allow("ReadApplicationSecrets", ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"], role.service === "migration" ? input.applicationSecretArn : [input.applicationSecretArn, queue]),
      ...(input.applicationSecretKmsKeyArn ? [allow("DecryptOnlyApplicationSecretKey", "kms:Decrypt", input.applicationSecretKmsKeyArn, { StringEquals: { "kms:ViaService": `secretsmanager.${region}.amazonaws.com`, "kms:EncryptionContext:SecretARN": input.applicationSecretArn } })] : []),
    ];
    const filename = `${role.name}-boundary.json`;
    bundle.policies[filename] = document(permissions);
    bundle.boundaries[role.arn] = { arn: role.boundaryArn, file: filename };
  }
  addFamily(bundle, "cloudformation", "workload-iam", [
    ...roles.map((role, index) => statement(`CreateOnlyBoundedRole${index}`, "iam:CreateRole", role.arn, { StringEquals: { "iam:PermissionsBoundary": role.boundaryArn } })),
    ...roles.map((role, index) => statement(`MutateOnlyBoundedRole${index}`, ["iam:PutRolePolicy", "iam:UpdateAssumeRolePolicy"], role.arn, { StringEquals: { "iam:PermissionsBoundary": role.boundaryArn } })),
    statement("ReadAndRemoveOnlyWorkloadRoles", ["iam:GetRole", "iam:GetRolePolicy", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:ListRoleTags", "iam:TagRole", "iam:UntagRole", "iam:DeleteRolePolicy", "iam:DeleteRole"], roles.map(role => role.arn)),
    statement("PassOnlyWorkloadRolesToTasks", "iam:PassRole", roles.map(role => role.arn), { StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } }),
    statement("NeverChangeBootstrapBoundaries", ["iam:PutRolePermissionsBoundary", "iam:DeleteRolePermissionsBoundary", "iam:CreatePolicy", "iam:CreatePolicyVersion", "iam:SetDefaultPolicyVersion", "iam:DeletePolicy", "iam:DeletePolicyVersion", "iam:AttachRolePolicy"], "*", {}, "Deny"),
  ]);
  const networkTypes = ["vpc", "subnet", "route-table", "internet-gateway", "security-group"];
  const network = networkTypes.map(type => arn("ec2", `${type}/*`));
  const creates = ["CreateVpc", "CreateSubnet", "CreateRouteTable", "CreateInternetGateway", "CreateSecurityGroup"];
  addFamily(bundle, "cloudformation", "network", [
    ...creates.map((action, index) => allow(`CreateTaggedNetwork${index}`, `ec2:${action}`, network[index], requestTags)),
    allow("CreateWithinTaggedVpc", ["ec2:CreateSubnet", "ec2:CreateRouteTable", "ec2:CreateSecurityGroup"], network[0], resourceTags),
    allow("TagOnlyDuringCreation", "ec2:CreateTags", network, merge(requestTags, { StringEquals: { "ec2:CreateAction": creates } })),
    allow("ChangeOnlyTaggedNetwork", ["ec2:DeleteVpc", "ec2:ModifyVpcAttribute", "ec2:DeleteSubnet", "ec2:ModifySubnetAttribute", "ec2:DeleteRouteTable", "ec2:CreateRoute", "ec2:ReplaceRoute", "ec2:DeleteRoute", "ec2:AssociateRouteTable", "ec2:DisassociateRouteTable", "ec2:DeleteInternetGateway", "ec2:AttachInternetGateway", "ec2:DetachInternetGateway", "ec2:DeleteSecurityGroup", "ec2:AuthorizeSecurityGroupIngress", "ec2:AuthorizeSecurityGroupEgress", "ec2:RevokeSecurityGroupIngress", "ec2:RevokeSecurityGroupEgress"], network, resourceTags),
    allow("ReadTaggedVpcAttributes", "ec2:DescribeVpcAttribute", network[0], resourceTags),
    allow("ReadRegionalNetworkMetadataException", ["ec2:DescribeVpcs", "ec2:DescribeSubnets", "ec2:DescribeRouteTables", "ec2:DescribeInternetGateways", "ec2:DescribeSecurityGroups", "ec2:DescribeSecurityGroupRules", "ec2:DescribeAvailabilityZones", "ec2:DescribeAccountAttributes", "ec2:DescribeNetworkInterfaces"], "*"),
  ]);
  addFamily(bundle, "cloudformation", "containers", [
    allow("ApplicationRepository", ["ecr:CreateRepository", "ecr:DescribeRepositories", "ecr:PutImageScanningConfiguration", "ecr:PutImageTagMutability", "ecr:PutLifecyclePolicy", "ecr:GetLifecyclePolicy", "ecr:DeleteLifecyclePolicy", "ecr:ListTagsForResource", "ecr:TagResource", "ecr:UntagResource"], ecr),
    allow("ApplicationCluster", ["ecs:CreateCluster", "ecs:DescribeClusters", "ecs:DeleteCluster", "ecs:UpdateCluster", "ecs:UpdateClusterSettings", "ecs:PutClusterCapacityProviders"], cluster),
    allow("ApplicationTaskDefinitions", "ecs:RegisterTaskDefinition", taskDefinitions),
    allow("ReadTaskDefinitionsRegionalException", "ecs:DescribeTaskDefinition", "*"),
    allow("ApplicationServices", ["ecs:CreateService", "ecs:UpdateService", "ecs:DeleteService", "ecs:DescribeServices"], services, { ArnEquals: { "ecs:cluster": cluster } }),
    allow("TagsOnNamedEcsResources", ["ecs:TagResource", "ecs:UntagResource", "ecs:ListTagsForResource"], [cluster, ...services, ...taskDefinitions]),
    allow("DeregisterTaskDefinitionRegionalException", "ecs:DeregisterTaskDefinition", "*"),
  ]);
  addFamily(bundle, "cloudformation", "loadbalancer", [
    allow("CreateNamedLoadBalancerAndListener", ["elasticloadbalancing:CreateLoadBalancer", "elasticloadbalancing:CreateListener"], alb),
    allow("ManageNamedLoadBalancer", ["elasticloadbalancing:DeleteLoadBalancer", "elasticloadbalancing:ModifyLoadBalancerAttributes", "elasticloadbalancing:SetSecurityGroups", "elasticloadbalancing:SetSubnets", "elasticloadbalancing:SetIpAddressType"], alb),
    allow("ManageNamedListeners", ["elasticloadbalancing:ModifyListener", "elasticloadbalancing:DeleteListener", "elasticloadbalancing:AddListenerCertificates", "elasticloadbalancing:RemoveListenerCertificates", "elasticloadbalancing:CreateRule"], listeners),
    allow("ManageNamedListenerRules", ["elasticloadbalancing:ModifyRule", "elasticloadbalancing:DeleteRule", "elasticloadbalancing:SetRulePriorities"], rules),
    allow("ManageNamedTargetGroup", ["elasticloadbalancing:CreateTargetGroup", "elasticloadbalancing:ModifyTargetGroup", "elasticloadbalancing:ModifyTargetGroupAttributes", "elasticloadbalancing:DeleteTargetGroup", "elasticloadbalancing:RegisterTargets", "elasticloadbalancing:DeregisterTargets"], target),
    allow("TagNamedLoadBalancerResources", ["elasticloadbalancing:AddTags", "elasticloadbalancing:RemoveTags"], [alb, listeners, rules, target]),
    allow("ReadRegionalLoadBalancerMetadataException", ["elasticloadbalancing:DescribeLoadBalancers", "elasticloadbalancing:DescribeLoadBalancerAttributes", "elasticloadbalancing:DescribeListeners", "elasticloadbalancing:DescribeListenerCertificates", "elasticloadbalancing:DescribeRules", "elasticloadbalancing:DescribeTargetGroups", "elasticloadbalancing:DescribeTargetGroupAttributes", "elasticloadbalancing:DescribeTargetHealth", "elasticloadbalancing:DescribeTags"], "*"),
    allow("ReadOnlyActualCertificate", "acm:DescribeCertificate", input.certificateArn),
  ]);
  const replication = arn("elasticache", "replicationgroup:admitflow-prod-queue");
  const cacheCluster = arn("elasticache", "cluster:admitflow-prod-queue-*");
  const subnet = arn("elasticache", "subnetgroup:admitflow-prod-queue-subnets");
  // Bootstrap owns this exact group; routine CFN can read/use it, never administer it.
  const parameters = input.cacheParameterGroupArn;
  const snapshots = arn("elasticache", "snapshot:admitflow-prod-queue-*");
  addFamily(bundle, "cloudformation", "queue", [
    allow("NamedCacheSubnetGroup", ["elasticache:CreateCacheSubnetGroup", "elasticache:ModifyCacheSubnetGroup", "elasticache:DeleteCacheSubnetGroup", "elasticache:DescribeCacheSubnetGroups"], subnet),
    allow("ReadExactTaggedParameterGroup", ["elasticache:DescribeCacheParameterGroups", "elasticache:DescribeCacheParameters", "elasticache:ListTagsForResource"], parameters, resourceTags),
    allow("UseExactTaggedParameterGroup", ["elasticache:CreateReplicationGroup", "elasticache:ModifyReplicationGroup"], parameters, resourceTags),
    allow("NamedReplicationGroup", ["elasticache:CreateReplicationGroup", "elasticache:ModifyReplicationGroup", "elasticache:DeleteReplicationGroup", "elasticache:DescribeReplicationGroups"], [replication, cacheCluster, subnet, snapshots]),
    allow("SnapshotNamedQueue", ["elasticache:CreateSnapshot", "elasticache:DescribeSnapshots"], [replication, cacheCluster, snapshots]),
    allow("ReadNamedCacheMembers", "elasticache:DescribeCacheClusters", cacheCluster),
    allow("TagNamedCacheResources", ["elasticache:AddTagsToResource", "elasticache:RemoveTagsFromResource", "elasticache:ListTagsForResource"], [replication, cacheCluster, subnet, snapshots]),
    allow("CreateNamedQueueSecret", "secretsmanager:CreateSecret", queue, { StringEquals: { "secretsmanager:Name": "admitflow/prod/queue-auth" } }),
    allow("ManageNamedQueueSecret", ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue", "secretsmanager:UpdateSecret", "secretsmanager:TagResource", "secretsmanager:UntagResource"], queue),
    allow("RandomPasswordRegionalException", "secretsmanager:GetRandomPassword", "*"),
  ]);
  const alarms = ["UnhealthyWeb", "WebServerErrors", "WebCpu", "WebMemory", "WorkerCpu", "WorkerMemory", "WorkerErrors", "QueueMemory1", "QueueMemory2", "QueueEvictions1", "QueueEvictions2"].map(name => arn("cloudwatch", `alarm:admitflow-prod-${name}`));
  addFamily(bundle, "cloudformation", "observability", [
    allow("NamedApplicationLogGroups", ["logs:CreateLogGroup", "logs:PutRetentionPolicy", "logs:DeleteRetentionPolicy", "logs:PutMetricFilter", "logs:DeleteMetricFilter", "logs:DescribeMetricFilters", "logs:ListTagsLogGroup", "logs:TagLogGroup", "logs:UntagLogGroup"], logApiArns),
    allow("NamedLogResourceTags", ["logs:TagResource", "logs:UntagResource", "logs:ListTagsForResource"], logArns),
    allow("RegionalLogDeliveryException", ["logs:CreateLogDelivery", "logs:GetLogDelivery", "logs:UpdateLogDelivery", "logs:DeleteLogDelivery", "logs:ListLogDeliveries", "logs:DescribeLogGroups", "logs:DescribeResourcePolicies"], "*"),
    allow("NamedApplicationAlarms", ["cloudwatch:PutMetricAlarm", "cloudwatch:DeleteAlarms", "cloudwatch:DescribeAlarms", "cloudwatch:TagResource", "cloudwatch:UntagResource", "cloudwatch:ListTagsForResource"], alarms),
  ]);
}

export function writeBundle(bundle, directory) {
  const output = resolve(directory);
  if (existsSync(output)) throw new Error("Output directory must not already exist");
  mkdirSync(output, { recursive: true });
  for (const [group, files] of Object.entries({ policies: bundle.policies, trust: bundle.trust, "resource-policies": bundle.resourcePolicies, requests: bundle.requests })) {
    mkdirSync(join(output, group));
    for (const [name, value] of Object.entries(files)) writeFileSync(join(output, group, name.endsWith(".json") ? name : `${name}.json`), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  }
  writeFileSync(join(output, "manifest.json"), `${JSON.stringify(bundle, null, 2)}\n`, { flag: "wx" });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--help") console.log("Offline only: node infra/iam/generate.mjs <prerequisites|cache-parameters-create|cache-parameters-configure|tenant-key-create|tenant-key-configure|certificate-metadata|secret-update|deployment|dns-validation|dns-application|release-operator> <identifier-input.json> <new-output-directory>. No credentials, API calls or attachments.");
    else {
      if (args.length !== 3) throw new Error("Expected phase, identifier input path and new output directory; see --help");
      writeBundle(generate(args[0], JSON.parse(readFileSync(resolve(args[1]), "utf8"))), args[2]);
      console.log("Offline policy candidate generated. AWS validation and independent review remain required.");
    }
  } catch (error) { console.error(error instanceof SyntaxError ? "Invalid identifier JSON" : error.message); process.exitCode = 1; }
}
