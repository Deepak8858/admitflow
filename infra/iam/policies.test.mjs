import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CACHE_PARAMETERS, CONTRACT, WORKLOAD_ROLES, generate, splitManagedPolicies, writeBundle } from "./generate.mjs";
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
  const required = { deployment: ["applicationSecretArn", "applicationSecretKeyMode", "certificateArn", "tenantKeyArn", "cacheParameterGroupArn"], "cache-parameters-configure": ["cacheParameterGroupArn"], "tenant-key-configure": ["tenantKeyArn"], "certificate-metadata": ["certificateArn"], "secret-update": ["applicationSecretArn", "applicationSecretKeyMode"], "dns-validation": ["certificateArn", "validationRecordName"], "dns-application": ["certificateArn", "loadBalancerArn", "targetGroupArn"], "release-operator": ["migrationTaskDefinitionArn"] };
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
test("tenant key identifiers reject foreign, alias, multiregion and malformed inputs", () => {
  for (const phase of ["deployment", "tenant-key-configure"]) for (const tenantKeyArn of [
    undefined, null, false, {}, "", "*", SYNTHETIC_KEY.replace("543777713748", "111111111111"),
    SYNTHETIC_KEY.replace("ap-southeast-1", "us-east-1"), SYNTHETIC_KEY.replace("arn:aws:", "arn:aws-cn:"),
    SYNTHETIC_KEY.replace(/key\/.+$/, "alias/admitflow-prod-tenant-credentials"),
    SYNTHETIC_KEY.replace(/key\/.+$/, "key/mrk-22222222222242228222222222222222"),
    SYNTHETIC_KEY.replace(/key\/.+$/, `key/${"-".repeat(36)}`), `${SYNTHETIC_KEY}\n`, `${SYNTHETIC_KEY}*`,
  ]) assert.throws(() => generate(phase, { ...SYNTHETIC_INPUT, tenantKeyArn }), /tenantKeyArn/);
});
test("cache parameter identifiers reject missing, foreign, wildcard and normalized substitutes", () => {
  const arn = CACHE_PARAMETERS.arn;
  for (const phase of ["deployment", "cache-parameters-configure"]) for (const cacheParameterGroupArn of [
    undefined, null, false, {}, [], 1, "", "*", CACHE_PARAMETERS.name, `${arn}*`, `${arn}-other`, `${arn}\n`, ` ${arn}`,
    arn.replace(CONTRACT.account, "111111111111"), arn.replace(CONTRACT.region, "us-east-1"),
    arn.replace("arn:aws:", "arn:aws-cn:"), arn.replace("-v1", "-v2"), arn.toUpperCase(),
    arn.replace(CACHE_PARAMETERS.name, "admitf-cache-xlqszxaqy5hl"),
  ]) assert.throws(() => generate(phase, { ...SYNTHETIC_INPUT, cacheParameterGroupArn }), /cacheParameterGroupArn/);
  assert.throws(() => generate("cache-parameters-create", { ...CONTRACT, cacheParameterGroupArn: `${arn}-other` }), /cacheParameterGroupArn/);
  const { cacheParameterGroupArn: ignored, ...missing } = SYNTHETIC_INPUT;
  assert.throws(() => simulationInputs(missing), /cacheParameterGroupArn/);
});
test("cache requests and phase action sets are exact, isolated and review-only", () => {
  const create = generate("cache-parameters-create", CONTRACT);
  const configure = generate("cache-parameters-configure", { ...CONTRACT, cacheParameterGroupArn: CACHE_PARAMETERS.arn });
  assert.deepEqual(create.requests, { "create-cache-parameter-group.json": {
    CacheParameterGroupName: "admitflow-prod-queue-valkey7-v1", CacheParameterGroupFamily: "valkey7",
    Description: "BullMQ requires noeviction on node-based Valkey",
    Tags: [{ Key: "Application", Value: "AdmitFlow" }, { Key: "Environment", Value: "prod" }],
  } });
  assert.deepEqual(configure.requests, { "modify-cache-parameter-group.json": {
    CacheParameterGroupName: CACHE_PARAMETERS.name,
    ParameterNameValues: [{ ParameterName: "maxmemory-policy", ParameterValue: "noeviction" }],
  } });
  const reads = ["elasticache:DescribeCacheParameterGroups", "elasticache:DescribeCacheParameters", "elasticache:ListTagsForResource"];
  for (const [bundle, writes] of [[create, ["elasticache:CreateCacheParameterGroup", "elasticache:AddTagsToResource"]], [configure, ["elasticache:ModifyCacheParameterGroup"]]]) {
    const statements = policiesFor(bundle, "bootstrap").flatMap(policy => policy.Statement);
    assert.deepEqual(statements.flatMap(statement => statement.Action).sort(), [...reads, ...writes].sort());
    for (const statement of statements) assert.deepEqual(statement.Resource, [CACHE_PARAMETERS.arn]);
    assert.equal(bundle.validation.status, "OFFLINE_CANDIDATE_NOT_AWS_VALIDATED");
    assert.deepEqual(bundle.trust.bootstrap, bundles.prerequisites.trust.bootstrap);
    assert.deepEqual(bundle.boundaries, {}); assert.deepEqual(bundle.resourcePolicies, {});
  }
  assert.ok(!JSON.stringify(bundles.prerequisites.policies).includes("parametergroup:"));
  assert.ok(!JSON.stringify(bundles.deployment.policies).includes("admitflow-prod-cacheparameters-"));
  const statements = policiesFor(bundles.deployment, "cloudformation").flatMap(policy => policy.Statement)
    .filter(statement => statement.Resource.some(resource => resource.includes(":parametergroup:")));
  assert.equal(statements.length, 2);
  for (const statement of statements) {
    assert.deepEqual(statement.Resource, [CACHE_PARAMETERS.arn]);
    assert.deepEqual(statement.Condition, { StringEquals: { "aws:RequestedRegion": CONTRACT.region, "aws:ResourceTag/Application": "AdmitFlow", "aws:ResourceTag/Environment": "prod" } });
  }
  assert.deepEqual(statements.flatMap(statement => statement.Action).sort(), [...reads, "elasticache:CreateReplicationGroup", "elasticache:ModifyReplicationGroup"].sort());
});

test("queue snapshot resources use only the observed CFN stack and logical ID prefix", () => {
  const statements = policiesFor(bundles.deployment, "cloudformation").flatMap(policy => policy.Statement)
    .filter(statement => statement.Resource.some(resource => resource.includes(":snapshot:")));
  assert.deepEqual(statements.map(statement => statement.Sid).sort(), ["NamedReplicationGroup", "SnapshotNamedQueue", "TagNamedCacheResources"].sort());
  const resource = name => `arn:aws:elasticache:ap-southeast-1:543777713748:${name}`;
  const sources = [resource("replicationgroup:admitflow-prod-queue"), resource("cluster:admitflow-prod-queue-*")];
  const snapshot = resource("snapshot:admitflow-prod-snapshot-queue-*");
  const actions = {
    NamedReplicationGroup: ["elasticache:CreateReplicationGroup", "elasticache:ModifyReplicationGroup", "elasticache:DeleteReplicationGroup", "elasticache:DescribeReplicationGroups"],
    SnapshotNamedQueue: ["elasticache:CreateSnapshot", "elasticache:DescribeSnapshots"],
    TagNamedCacheResources: ["elasticache:AddTagsToResource", "elasticache:RemoveTagsFromResource", "elasticache:ListTagsForResource"],
  };
  for (const statement of statements) {
    assert.equal(statement.Effect, "Allow");
    assert.deepEqual(statement.Action, actions[statement.Sid]);
    assert.deepEqual(statement.Resource, [...sources, ...(statement.Sid === "SnapshotNamedQueue" ? [] : [resource("subnetgroup:admitflow-prod-queue-subnets")]), snapshot]);
    assert.deepEqual(statement.Condition, { StringEquals: { "aws:RequestedRegion": CONTRACT.region } });
  }
});

test("positive snapshot simulation vectors use AWS-supported action resource types", () => {
  const cases = validationCases(SYNTHETIC_INPUT).filter(item => item.id.startsWith("queue-snapshot-") && item.expected === "allowed");
  assert.equal(cases.length, 11);
  for (const item of cases) assert.ok(sar[item.action].resources.includes(item.resource.split(":")[5]), `${item.id}: unsupported action/resource pair`);
  for (const action of ["elasticache:DeleteReplicationGroup", "elasticache:CreateSnapshot", "elasticache:AddTagsToResource"]) {
    const types = cases.filter(item => item.action === action).map(item => item.resource.split(":")[5]).sort();
    assert.deepEqual(types, action === "elasticache:DeleteReplicationGroup" ? ["replicationgroup", "snapshot"] : ["cluster", "replicationgroup", "snapshot"]);
  }
});

test("bootstrap request artifacts omit creation tags and remove the temporary key-policy grant", () => {
  const creation = generate("tenant-key-create", CONTRACT);
  const setup = bundles["tenant-key-configure"];
  const request = creation.requests["create-key.json"];
  assert.deepEqual(Object.keys(request).sort(), ["Description", "KeySpec", "KeyUsage", "Origin", "MultiRegion", "BypassPolicyLockoutSafetyCheck", "Policy"].sort());
  assert.equal(request.KeySpec, "SYMMETRIC_DEFAULT"); assert.equal(request.KeyUsage, "ENCRYPT_DECRYPT");
  assert.equal(request.Origin, "AWS_KMS"); assert.equal(request.MultiRegion, false);
  assert.equal(request.BypassPolicyLockoutSafetyCheck, false);
  assert.equal("Tags" in request, false);
  const initial = JSON.parse(request.Policy);
  assert.deepEqual(initial, creation.resourcePolicies["tenant-key-initial.json"]);
  assert.equal(initial.Statement.length, 2);
  assert.deepEqual(initial.Statement[1], {
    Sid: "TemporaryBootstrapPolicyUpdate", Effect: "Allow", Principal: { AWS: CONTRACT.bootstrapRoleArn },
    Action: "kms:PutKeyPolicy", Resource: "*", Condition: { Bool: { "kms:BypassPolicyLockoutSafetyCheck": "false" } },
  });
  const finalRequest = setup.requests["put-key-policy.json"];
  assert.equal(finalRequest.KeyId, SYNTHETIC_KEY); assert.equal(finalRequest.PolicyName, "default");
  assert.equal(finalRequest.BypassPolicyLockoutSafetyCheck, false);
  const finalPolicy = JSON.parse(finalRequest.Policy);
  assert.deepEqual(finalPolicy, setup.resourcePolicies["tenant-key-final.json"]);
  assert.deepEqual(finalPolicy.Statement, [{ Sid: "EnableAccountIamDelegation", Effect: "Allow", Principal: { AWS: `arn:aws:iam::${CONTRACT.account}:root` }, Action: "kms:*", Resource: "*" }]);
  assert.ok(!JSON.stringify(finalPolicy).includes(CONTRACT.bootstrapRoleArn));
  assert.equal(model(policiesFor(setup, "bootstrap"), "kms:PutKeyPolicy", SYNTHETIC_KEY, { "aws:RequestedRegion": CONTRACT.region, "kms:BypassPolicyLockoutSafetyCheck": "false" }), "allowed", "IAM permission remains for final policy safety check before detachment");
  assert.deepEqual(setup.requests["tag-resource.json"], { KeyId: SYNTHETIC_KEY, Tags: [{ TagKey: "Application", TagValue: "AdmitFlow" }, { TagKey: "Environment", TagValue: "prod" }] });
  assert.deepEqual(setup.requests["enable-key-rotation.json"], { KeyId: SYNTHETIC_KEY });
  assert.deepEqual(setup.requests["create-alias.json"], { AliasName: "alias/admitflow-prod-tenant-credentials", TargetKeyId: SYNTHETIC_KEY });
  assert.deepEqual(policiesFor(creation, "bootstrap").flatMap(policy => policy.Statement).filter(statement => statement.Effect === "Allow").flatMap(statement => statement.Action), ["kms:CreateKey"]);
});
test("routine identities have no KMS administration and workload boundaries name one key", () => {
  for (const identity of ["deploy", "cloudformation", "publisher"]) {
    const actions = policiesFor(bundles.deployment, identity).flatMap(policy => policy.Statement).flatMap(statement => statement.Action);
    assert.ok(actions.every(action => !action.startsWith("kms:")));
  }
  for (const workload of ["web", "worker"]) {
    const statements = bundles.deployment.policies[`admitflow-prod-${workload}-task-boundary.json`].Statement;
    assert.equal(statements.length, 1); assert.deepEqual(statements[0].Resource, [SYNTHETIC_KEY]);
    assert.deepEqual(statements[0].Condition, { StringEquals: { "aws:RequestedRegion": CONTRACT.region } });
  }
});
test("bootstrap bundle writer preserves review-only request and resource-policy JSON", () => {
  const directory = mkdtempSync(join(tmpdir(), "admitflow-key-artifacts-"));
  try {
    for (const phase of ["tenant-key-create", "tenant-key-configure", "cache-parameters-create", "cache-parameters-configure"]) {
      const output = join(directory, phase); const bundle = bundles[phase]; writeBundle(bundle, output);
      for (const [name, request] of Object.entries(bundle.requests)) assert.deepEqual(JSON.parse(readFileSync(join(output, "requests", name), "utf8")), request);
      for (const [name, policy] of Object.entries(bundle.resourcePolicies)) assert.deepEqual(JSON.parse(readFileSync(join(output, "resource-policies", name), "utf8")), policy);
      assert.throws(() => writeBundle(bundle, output), /already exist/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test("workload lookup exception is an isolated six-name GetRole-only family", () => {
  const filename = "cloudformation-workload-lookup-1.json";
  assert.deepEqual(bundles.deployment.policies[filename], {
    Version: "2012-10-17",
    Statement: [{ Sid: "ReadExactWorkloadRoleNames", Effect: "Allow", Action: ["iam:GetRole"], Resource: [
      "arn:aws:iam::543777713748:role/admitflow-prod-web-task",
      "arn:aws:iam::543777713748:role/admitflow-prod-web-execution",
      "arn:aws:iam::543777713748:role/admitflow-prod-worker-task",
      "arn:aws:iam::543777713748:role/admitflow-prod-worker-execution",
      "arn:aws:iam::543777713748:role/admitflow-prod-migration-task",
      "arn:aws:iam::543777713748:role/admitflow-prod-migration-execution",
    ] }],
  });
  assert.equal(bundles.deployment.attachments.cloudformation.length, 7);
  for (const [identity, files] of Object.entries(bundles.deployment.attachments))
    assert.equal(files.includes(filename), identity === "cloudformation");
  for (const [phase, bundle] of Object.entries(bundles))
    assert.equal(Object.hasOwn(bundle.policies, filename), phase === "deployment");
  assert.equal(bundles.deployment.sizes["cloudformation-workload-iam-1.json"], 6006);
  const statements = bundles.deployment.policies["cloudformation-workload-iam-1.json"].Statement;
  assert.deepEqual(statements.find(item => item.Sid === "ReadAndRemoveOnlyWorkloadRoles").Resource, WORKLOAD_ROLES.map(role => role.arn));
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
test("exact immutable GitHub main-ref trust excludes PR, environment, branch and repository variants", () => {
  const trust = bundles.deployment.trust.publisher.Statement[0];
  assert.equal(trust.Principal.Federated, "arn:aws:iam::543777713748:oidc-provider/token.actions.githubusercontent.com");
  const context = { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com", "token.actions.githubusercontent.com:sub": "repo:Deepak8858@88921480/admitflow@1376846550:ref:refs/heads/main" };
  assert.equal(matchesConditions(trust.Condition, context), true);
  for (const sub of ["repo:Deepak8858/admitflow:ref:refs/heads/main", "repo:Deepak8858@88921480/admitflow@1376846550:pull_request", "repo:Deepak8858@88921480/admitflow@1376846550:environment:production", "repo:Deepak8858@88921480/admitflow@1376846550:ref:refs/heads/dev", "repo:another@88921480/admitflow@1376846550:ref:refs/heads/main"]) assert.equal(matchesConditions(trust.Condition, { ...context, "token.actions.githubusercontent.com:sub": sub }), false);
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
  for (const key of ["kms:MultiRegion", "kms:BypassPolicyLockoutSafetyCheck"]) assert.ok(cases.find(item => item.id === "bootstrap-create-untagged-key").input.ContextEntries.some(entry => entry.ContextKeyName === key && entry.ContextKeyType === "boolean"));
  assert.equal(new Set(cases.map(item => item.id)).size, cases.length);
  for (const item of cases) for (const entry of item.input.ContextEntries) {
    assert.ok(entry.ContextKeyValues.length > 0);
    assert.ok(entry.ContextKeyValues.every(value => typeof value === "string"));
  }
  const missingApplication = cases.find(item => item.id === "cache-create-reject-missingApplication-elasticache:CreateCacheParameterGroup");
  assert.ok(!missingApplication.input.ContextEntries.some(entry => entry.ContextKeyName === "aws:RequestTag/Application"));
  const emptyKeys = cases.find(item => item.id === "cache-create-reject-emptyKeys-elasticache:CreateCacheParameterGroup");
  assert.ok(!emptyKeys.input.ContextEntries.some(entry => entry.ContextKeyName === "aws:TagKeys"));
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
