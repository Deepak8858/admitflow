import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTRACT, WORKLOAD_ROLES, generate, splitManagedPolicies, writeBundle } from "./generate.mjs";
import { PHASES, SYNTHETIC_INPUT, SYNTHETIC_KEY } from "./fixtures.mjs";
import { validationCases, policiesFor, simulationInputs } from "./validation.mjs";

const sar = JSON.parse(readFileSync(new URL("./sar-actions.json", import.meta.url), "utf8")).actions;
const array = value => Array.isArray(value) ? value : [value];
const glob = (pattern, actual) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")}$`).test(actual);
// Deliberately SMALL statement matcher for regression tests, NOT AWS IAM simulation.
// No principal/session/SCP/resource-policy, resource-type or multi-resource API semantics are evaluated here.
function matchesConditions(conditions, context) {
  return Object.entries(conditions ?? {}).every(([operator, entries]) => Object.entries(entries).every(([key, expected]) => {
    const actual = context[key];
    if (operator === "Null") return String(actual === undefined || (Array.isArray(actual) && !actual.length)) === expected;
    if (operator === "ForAllValues:StringEquals") return actual === undefined || array(actual).every(value => array(expected).includes(value));
    if (actual === undefined) return false;
    if (["StringEquals", "ArnEquals", "Bool"].includes(operator)) return array(actual).some(value => array(expected).includes(String(value)));
    if (["StringLike", "ArnLike"].includes(operator)) return array(actual).some(value => array(expected).some(pattern => glob(pattern, value)));
    throw new Error(`Unsupported offline test operator: ${operator}`);
  }));
}
function model(policies, action, resource, context) {
  const statements = policies.flatMap(policy => policy.Statement).filter(statement => array(statement.Action).some(pattern => glob(pattern.toLowerCase(), action.toLowerCase())) && array(statement.Resource).some(pattern => glob(pattern, resource)) && matchesConditions(statement.Condition, context));
  return statements.some(statement => statement.Effect === "Deny") ? "explicitDeny" : statements.length ? "allowed" : "implicitDeny";
}
const bundles = Object.fromEntries(PHASES.map(phase => [phase, generate(phase, SYNTHETIC_INPUT)]));

for (const item of validationCases(SYNTHETIC_INPUT)) test(`offline statement regression (not AWS simulation): ${item.id}`, () => {
  assert.equal(model(policiesFor(bundles[item.phase], item.identity), item.action, item.resource, item.context), item.expected);
});

test("fail closed for every missing or changed fixed contract field", () => {
  for (const key of Object.keys(CONTRACT)) {
    assert.throws(() => generate("prerequisites", { ...CONTRACT, [key]: undefined }));
    assert.throws(() => generate("prerequisites", { ...CONTRACT, [key]: `${CONTRACT[key]}*` }));
  }
  assert.throws(() => generate("deployment", CONTRACT));
  assert.throws(() => generate("prerequisites", { ...CONTRACT, SECRET_VALUE: "not-accepted" }), /Unexpected input/);
  assert.throws(() => generate("unknown", CONTRACT), /Unknown phase/);
});
test("missing phase identifiers never produce wildcard substitutes", () => {
  const required = { deployment: ["applicationSecretArn", "applicationSecretKeyMode", "certificateArn"], "certificate-metadata": ["certificateArn"], "secret-update": ["applicationSecretArn", "applicationSecretKeyMode"], "dns-validation": ["certificateArn", "validationRecordName"], "dns-application": ["certificateArn", "loadBalancerArn", "targetGroupArn"], "release-operator": ["migrationTaskDefinitionArn"] };
  for (const [phase, keys] of Object.entries(required)) for (const key of keys) {
    assert.throws(() => generate(phase, { ...SYNTHETIC_INPUT, [key]: undefined }));
    assert.throws(() => generate(phase, { ...SYNTHETIC_INPUT, [key]: "*" }));
  }
  assert.throws(() => generate("deployment", { ...SYNTHETIC_INPUT, applicationSecretArn: SYNTHETIC_INPUT.applicationSecretArn.replace("AbCd12", "") }));
  assert.throws(() => generate("deployment", { ...SYNTHETIC_INPUT, applicationSecretArn: SYNTHETIC_INPUT.applicationSecretArn.replace("543777713748", "111111111111") }));
  assert.throws(() => generate("deployment", { ...SYNTHETIC_INPUT, certificateArn: SYNTHETIC_INPUT.certificateArn.replace("ap-southeast-1", "us-east-1") }));
  assert.throws(() => generate("dns-validation", { ...SYNTHETIC_INPUT, validationRecordName: "*.admitflow.incfrog.ai" }));
});
test("customer key and generated ARN tightening require exact verified scope", () => {
  assert.throws(() => generate("deployment", { ...SYNTHETIC_INPUT, applicationSecretKeyMode: "customer-managed" }));
  assert.throws(() => generate("deployment", { ...SYNTHETIC_INPUT, applicationSecretKmsKeyArn: SYNTHETIC_KEY }));
  assert.throws(() => generate("deployment", { ...SYNTHETIC_INPUT, tenantKeyArn: "arn:aws:kms:ap-southeast-1:543777713748:key/*" }));
  const input = { ...SYNTHETIC_INPUT, applicationSecretKeyMode: "customer-managed", applicationSecretKmsKeyArn: SYNTHETIC_KEY, tenantKeyArn: SYNTHETIC_KEY, queueSecretArn: "arn:aws:secretsmanager:ap-southeast-1:543777713748:secret:admitflow/prod/queue-auth-AbCd12" };
  const bundle = generate("deployment", input);
  const execution = bundle.policies["admitflow-prod-web-execution-boundary.json"];
  const keyStatement = execution.Statement.find(statement => statement.Action.includes("kms:Decrypt"));
  assert.deepEqual(keyStatement.Resource, [SYNTHETIC_KEY]);
  assert.equal(keyStatement.Condition.StringEquals["kms:EncryptionContext:SecretARN"], input.applicationSecretArn);
  assert.ok(!JSON.stringify(bundle.policies["admitflow-prod-web-task-boundary.json"]).includes("key/*"));
});
test("managed policy quota, attachments, trust quota and boundary count", () => {
  for (const bundle of Object.values(bundles)) {
    for (const policy of Object.values(bundle.policies)) assert.ok(JSON.stringify(policy).length <= 6144);
    for (const files of Object.values(bundle.attachments)) assert.ok(files.length <= 10);
    for (const trust of Object.values(bundle.trust)) assert.ok(JSON.stringify(trust).length <= 2048);
  }
  assert.equal(Object.keys(bundles.deployment.boundaries).length, 6);
  for (const role of WORKLOAD_ROLES) assert.equal(bundles.deployment.boundaries[role.arn].arn, role.boundaryArn);
  const statements = bundles.deployment.policies["cloudformation-workload-iam-1.json"].Statement;
  assert.ok(splitManagedPolicies(statements, 2000).length > 1);
  assert.throws(() => splitManagedPolicies(statements, 10), /quota/);
});
test("every allowed action is explicit and selected SAR metadata agrees with unscoped resources/conditions", () => {
  for (const bundle of Object.values(bundles)) for (const policy of Object.values(bundle.policies)) for (const statement of policy.Statement) {
    if (statement.Effect === "Deny") continue;
    for (const action of statement.Action) {
      assert.ok(!action.includes("*") && !action.includes("?"), action);
      if (action.startsWith("sts:")) continue;
      const metadata = sar[action]; assert.ok(metadata, `${action} absent from reviewed SAR fixture`);
      if (!metadata.resources.length) assert.deepEqual(statement.Resource, ["*"], `${action} cannot be ARN-scoped`);
      else assert.ok(!statement.Resource.includes("*"), `${action} must use supported resource types`);
      for (const entries of Object.values(statement.Condition ?? {})) for (const key of Object.keys(entries)) {
        if (key === "aws:RequestedRegion") continue;
        const normalized = key.replace(/^(aws:(?:Request|Resource)Tag)\/.+$/, "$1/${TagKey}");
        assert.ok(metadata.conditions.includes(normalized), `${action}: unsupported ${key}`);
      }
    }
  }
});
test("CloudFormation change sets use stack resources and no incompatible ResourceTypes promise", () => {
  const policies = policiesFor(bundles.deployment, "deploy");
  assert.ok(!JSON.stringify(policies).includes("cloudformation:ResourceTypes"));
  for (const statement of policies.flatMap(policy => policy.Statement)) if (statement.Action.some(action => action.startsWith("cloudformation:"))) assert.deepEqual(statement.Resource, ["arn:aws:cloudformation:ap-southeast-1:543777713748:stack/AdmitFlow-prod/*"]);
});
test("exact GitHub main-ref trust excludes PR, environment, branch and repository variants", () => {
  const trust = bundles.deployment.trust.publisher.Statement[0];
  assert.equal(trust.Principal.Federated, "arn:aws:iam::543777713748:oidc-provider/token.actions.githubusercontent.com");
  const context = { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com", "token.actions.githubusercontent.com:sub": "repo:Deepak8858/admitflow:ref:refs/heads/main" };
  assert.equal(matchesConditions(trust.Condition, context), true);
  for (const sub of ["repo:Deepak8858/admitflow:pull_request", "repo:Deepak8858/admitflow:environment:production", "repo:Deepak8858/admitflow:ref:refs/heads/dev", "repo:another/admitflow:ref:refs/heads/main"]) assert.equal(matchesConditions(trust.Condition, { ...context, "token.actions.githubusercontent.com:sub": sub }), false);
  assert.equal(matchesConditions(trust.Condition, { ...context, "token.actions.githubusercontent.com:aud": "other" }), false);
});
test("operator trusts require exact user and explicit MFA; no browser-login assumption", () => {
  for (const trust of [bundles.deployment.trust.deploy, bundles.prerequisites.trust.bootstrap]) {
    assert.equal(trust.Statement[0].Principal.AWS, CONTRACT.operatorArn);
    assert.equal(matchesConditions(trust.Statement[0].Condition, {}), false);
    assert.equal(matchesConditions(trust.Statement[0].Condition, { "aws:MultiFactorAuthPresent": "false" }), false);
    assert.equal(matchesConditions(trust.Statement[0].Condition, { "aws:MultiFactorAuthPresent": "true" }), true);
  }
});
test("one-off log policy is isolated and task/service roles do not own bootstrap policies", () => {
  for (const identity of ["deploy", "cloudformation", "publisher"]) {
    const actions = policiesFor(bundles.deployment, identity).flatMap(policy => policy.Statement).filter(statement => statement.Effect === "Allow").flatMap(statement => statement.Action);
    assert.ok(!actions.includes("logs:PutResourcePolicy")); assert.ok(!actions.includes("logs:DeleteResourcePolicy"));
  }
  const actions = policiesFor(bundles.prerequisites, "bootstrap").flatMap(policy => policy.Statement).flatMap(statement => statement.Action);
  assert.ok(actions.includes("logs:PutResourcePolicy")); assert.ok(!actions.includes("logs:DeleteResourcePolicy"));
  assert.equal(bundles.prerequisites.resourcePolicies["valkey-log-delivery.json"].Statement[0].Principal.Service, "delivery.logs.amazonaws.com");
  assert.deepEqual(bundles["release-operator"].trust, {});
});
test("log-group IAM actions use documented suffixed ARN except Resource tagging APIs", () => {
  const statements = policiesFor(bundles.deployment, "cloudformation").flatMap(policy => policy.Statement);
  const create = statements.find(statement => statement.Action.includes("logs:CreateLogGroup"));
  assert.equal(create.Resource.length, 4);
  assert.ok(create.Resource.every(resource => resource.endsWith(":*") && resource.includes(":log-group:")));
  const tag = statements.find(statement => statement.Action.includes("logs:TagResource"));
  assert.equal(tag.Resource.length, 4);
  assert.ok(tag.Resource.every(resource => !resource.endsWith(":*")));
});
test("AWS simulation export is inputs only, preserving conditions and explicit expectations", () => {
  const cases = simulationInputs(SYNTHETIC_INPUT);
  assert.equal(cases.length, validationCases(SYNTHETIC_INPUT).length);
  for (const item of cases) { assert.equal(item.input.ActionNames.length, 1); assert.ok(item.input.PolicyInputList.length); assert.ok(!("EvaluationResults" in item)); }
  assert.ok(cases.some(item => item.expected === "explicitDeny"));
  assert.ok(cases.find(item => item.id === "migration-no-exec").input.ContextEntries.some(entry => entry.ContextKeyName === "ecs:enable-execute-command" && entry.ContextKeyType === "boolean"));
});
test("offline bundle writer emits inspectable policy files and refuses overwrite", () => {
  const directory = mkdtempSync(join(tmpdir(), "admitflow-iam-test-"));
  try {
    const output = join(directory, "candidate"); writeBundle(bundles.deployment, output);
    assert.equal(readdirSync(join(output, "policies")).length, Object.keys(bundles.deployment.policies).length);
    assert.deepEqual(JSON.parse(readFileSync(join(output, "manifest.json"), "utf8")).boundaries, bundles.deployment.boundaries);
    assert.throws(() => writeBundle(bundles.deployment, output), /already exist/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
