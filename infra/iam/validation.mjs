import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { CONTRACT, WORKLOAD_ROLES, generate } from "./generate.mjs";

const regional = { "aws:RequestedRegion": CONTRACT.region };
const ar = (service, resource) => `arn:aws:${service}:${CONTRACT.region}:${CONTRACT.account}:${resource}`;
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
  const vpc = ar("ec2", "vpc/vpc-11111111111111111");
  add("own-vpc-delete", "deployment", "cloudformation", "ec2:DeleteVpc", vpc, "allowed", resourceTags);
  add("unrelated-vpc-delete", "deployment", "cloudformation", "ec2:DeleteVpc", vpc, "implicitDeny");
  add("cannot-relabel-vpc", "deployment", "cloudformation", "ec2:CreateTags", vpc, "implicitDeny", requestTags);
  add("create-tagged-vpc", "deployment", "cloudformation", "ec2:CreateVpc", vpc, "allowed", requestTags);
  add("create-untagged-vpc", "deployment", "cloudformation", "ec2:CreateVpc", vpc, "implicitDeny");
  const key = input.tenantKeyArn ?? ar("kms", "key/33333333-3333-4333-8333-333333333333");
  add("cannot-relabel-key", "deployment", "cloudformation", "kms:TagResource", key, input.tenantKeyArn ? "allowed" : "implicitDeny", requestTags);
  add("regional-alias-metadata", "deployment", "cloudformation", "kms:ListAliases", "*", "allowed");
  add("wrong-region-alias-metadata", "deployment", "cloudformation", "kms:ListAliases", "*", "implicitDeny", { "aws:RequestedRegion": "us-east-1" });
  add("publisher-no-alias-metadata", "deployment", "publisher", "kms:ListAliases", "*", "implicitDeny");
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
    ContextEntries: Object.entries(test.context).map(([ContextKeyName, value]) => ({ ContextKeyName, ContextKeyValues: Array.isArray(value) ? value : [value], ContextKeyType: Array.isArray(value) ? "stringList" : ["ecs:enable-execute-command", "aws:MultiFactorAuthPresent"].includes(ContextKeyName) ? "boolean" : "string" })),
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
