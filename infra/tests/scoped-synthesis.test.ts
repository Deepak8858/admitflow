import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { App, BootstraplessSynthesizer, CfnResource, FileAssetPackaging, Stack, Token } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { configureApplication } from "../configuration";
import { AdmitFlowStack, SHARED_SECRET_KEYS, WEB_SECRET_KEYS } from "../stack";
import { compactInlineTemplate, INLINE_TEMPLATE_LIMIT, PRODUCTION, PRODUCTION_CACHE_PARAMETER_GROUP_ARN, ScopedBootstraplessSynthesizer, valkeyLogDeliveryPolicy } from "../scoped-synthesis";
import { SYNTHETIC_KEY } from "../iam/fixtures.mjs";
import { CACHE_PARAMETERS } from "../iam/generate.mjs";

function application(t: TestContext, context: Record<string, unknown> = { ...PRODUCTION, tenantKeyArn: SYNTHETIC_KEY, cacheParameterGroupArn: PRODUCTION_CACHE_PARAMETER_GROUP_ARN }) {
  const root = resolve("infra/.test-output");
  mkdirSync(root, { recursive: true });
  const outdir = mkdtempSync(join(root, "scoped-"));
  t.after(() => rmSync(outdir, { recursive: true, force: true }));
  return new App({ outdir, autoSynth: false, context });
}

function production(t: TestContext) {
  const app = application(t);
  const stack = configureApplication(app);
  return { app, stack, template: Template.fromStack(stack) };
}

const workloads = ["web", "worker", "migration"] as const;

test("production requires explicit exact account, region and both deployment roles", t => {
  for (const key of ["account", "region", "deployRoleArn", "cloudFormationExecutionRoleArn"] as const) {
    for (const value of [undefined, "", "unexpected", null, false, 543777713748]) {
      assert.throws(() => configureApplication(application(t, { ...PRODUCTION, [key]: value })), /Production|region/);
    }
  }
  for (const overrides of [
    { account: "123456789012" }, { region: "us-east-1" },
    { deployRoleArn: PRODUCTION.cloudFormationExecutionRoleArn },
    { cloudFormationExecutionRoleArn: PRODUCTION.deployRoleArn },
  ]) assert.throws(() => configureApplication(application(t, { ...PRODUCTION, ...overrides })), /Production/);
  for (const stage of ["Prod", "prod ", {}, false, 1]) assert.throws(() => configureApplication(application(t, { ...PRODUCTION, stage })), /stage/);
});

test("direct production construction cannot bypass scoped entrypoint guards", t => {
  const props = { stage: "prod", env: { account: PRODUCTION.account, region: PRODUCTION.region }, availabilityZones: ["ap-southeast-1a", "ap-southeast-1b"] };
  assert.throws(() => new AdmitFlowStack(application(t), PRODUCTION.stackName, props), /BootstraplessSynthesizer/);
  assert.throws(() => new AdmitFlowStack(application(t), PRODUCTION.stackName, { ...props, env: { region: PRODUCTION.region } }), /account/);
  assert.throws(() => new AdmitFlowStack(application(t), "WrongStack", props), /stack name/);
  assert.throws(() => new ScopedBootstraplessSynthesizer({ deployRoleArn: "", cloudFormationExecutionRoleArn: PRODUCTION.cloudFormationExecutionRoleArn }), /deployRoleArn/);
  assert.throws(() => new ScopedBootstraplessSynthesizer({ deployRoleArn: PRODUCTION.deployRoleArn, cloudFormationExecutionRoleArn: "" }), /cloudFormationExecutionRoleArn/);
});

test("production key is required at entrypoint and direct construction; aliases and foreign ARNs fail closed", t => {
  const invalid = [undefined, null, false, {}, "", "*", SYNTHETIC_KEY.replace("543777713748", "111111111111"),
    SYNTHETIC_KEY.replace("ap-southeast-1", "us-east-1"), SYNTHETIC_KEY.replace("arn:aws:", "arn:aws-cn:"),
    SYNTHETIC_KEY.replace(/key\/.+$/, "alias/admitflow-prod-tenant-credentials"),
    SYNTHETIC_KEY.replace(/key\/.+$/, "key/mrk-22222222222242228222222222222222"),
    SYNTHETIC_KEY.replace(/key\/.+$/, `key/${"-".repeat(36)}`), `${SYNTHETIC_KEY}\n`, `${SYNTHETIC_KEY}*`];
  for (const tenantKeyArn of invalid) {
    assert.throws(() => configureApplication(application(t, { ...PRODUCTION, tenantKeyArn })), /tenantKeyArn/);
    assert.throws(() => new AdmitFlowStack(application(t), PRODUCTION.stackName, {
      stage: "prod", env: { account: PRODUCTION.account, region: PRODUCTION.region },
      availabilityZones: ["ap-southeast-1a", "ap-southeast-1b"], synthesizer: new ScopedBootstraplessSynthesizer(PRODUCTION),
      tenantKeyArn: tenantKeyArn as string,
    }), /tenantKeyArn/);
  }
  assert.throws(() => configureApplication(application(t, { tenantKeyArn: SYNTHETIC_KEY })), /offline fixtures/);
});

test("production requires the exact external parameter group at entrypoint and direct construction", t => {
  const arn = PRODUCTION_CACHE_PARAMETER_GROUP_ARN;
  const invalid = [undefined, null, false, {}, 1, "", "*", PRODUCTION.cacheParameterGroupName,
    arn.replace(PRODUCTION.account, "111111111111"), arn.replace(PRODUCTION.region, "us-east-1"),
    arn.replace("arn:aws:", "arn:aws-cn:"), arn.replace("-v1", "-v2"), arn.toUpperCase(),
    arn.replace(PRODUCTION.cacheParameterGroupName, "admitf-cache-xlqszxaqy5hl"),
    `${arn}*`, `${arn}-other`, ` ${arn}`, `${arn}\n`, Token.asString({ Ref: "UnverifiedGroup" })];
  for (const cacheParameterGroupArn of invalid) {
    assert.throws(() => configureApplication(application(t, { ...PRODUCTION, tenantKeyArn: SYNTHETIC_KEY, cacheParameterGroupArn })), /cacheParameterGroupArn/);
    assert.throws(() => new AdmitFlowStack(application(t), PRODUCTION.stackName, {
      stage: "prod", env: { account: PRODUCTION.account, region: PRODUCTION.region },
      availabilityZones: ["ap-southeast-1a", "ap-southeast-1b"], synthesizer: new ScopedBootstraplessSynthesizer(PRODUCTION),
      tenantKeyArn: SYNTHETIC_KEY, cacheParameterGroupArn: cacheParameterGroupArn as string,
    }), /cacheParameterGroupArn/);
  }
});

test("synthesis and IAM agree on the external group without resource ownership or a mutable parameter", t => {
  assert.equal(PRODUCTION_CACHE_PARAMETER_GROUP_ARN, CACHE_PARAMETERS.arn);
  assert.equal(PRODUCTION.cacheParameterGroupName, CACHE_PARAMETERS.name);
  assert.equal(CACHE_PARAMETERS.family, "valkey7");
  const app = application(t);
  const stack = new AdmitFlowStack(app, PRODUCTION.stackName, {
    stage: "prod", env: { account: PRODUCTION.account, region: PRODUCTION.region },
    availabilityZones: ["ap-southeast-1a", "ap-southeast-1b"], synthesizer: new ScopedBootstraplessSynthesizer(PRODUCTION),
    tenantKeyArn: SYNTHETIC_KEY, cacheParameterGroupArn: PRODUCTION_CACHE_PARAMETER_GROUP_ARN,
  });
  const template = Template.fromStack(stack);
  template.resourceCountIs("AWS::ElastiCache::ParameterGroup", 0);
  template.hasResourceProperties("AWS::ElastiCache::ReplicationGroup", { CacheParameterGroupName: CACHE_PARAMETERS.name });
  template.hasOutput("CacheParameterGroupName", { Value: CACHE_PARAMETERS.name });
  assert.equal(template.toJSON().Parameters.CacheParameterGroupName, undefined);
  assert.equal(template.toJSON().Parameters.CacheParameterGroupArn, undefined);
  assert.ok(!JSON.stringify(template.toJSON()).includes('"Ref":"CacheParameters"'));
});

test("offline fixtures retain their native noeviction group and reject external group inputs", t => {
  for (const cacheParameterGroupArn of [PRODUCTION_CACHE_PARAMETER_GROUP_ARN, null, false, ""]) {
    assert.throws(() => configureApplication(application(t, { cacheParameterGroupArn })), /offline fixtures.*cacheParameterGroupArn/);
    assert.throws(() => new AdmitFlowStack(application(t, {}), "Fixture", {
      stage: "test", env: { region: PRODUCTION.region }, availabilityZones: ["ap-southeast-1a", "ap-southeast-1b"],
      cacheParameterGroupArn: cacheParameterGroupArn as string,
    }), /offline fixtures.*cacheParameterGroupArn/);
  }
  const template = Template.fromStack(configureApplication(application(t, {})));
  template.resourceCountIs("AWS::ElastiCache::ParameterGroup", 1);
  template.hasResourceProperties("AWS::ElastiCache::ParameterGroup", { CacheParameterGroupFamily: "valkey7", Properties: { "maxmemory-policy": "noeviction" } });
  template.hasResourceProperties("AWS::ElastiCache::ReplicationGroup", { CacheParameterGroupName: { Ref: "CacheParameters" } });
  template.hasOutput("CacheParameterGroupName", { Value: { Ref: "CacheParameters" } });
});

test("production references the exact bootstrap key in outputs, web/worker environment and grants only", t => {
  const { template } = production(t);
  template.resourceCountIs("AWS::KMS::Key", 0); template.resourceCountIs("AWS::KMS::Alias", 0);
  template.hasOutput("TenantCredentialKeyArn", { Value: SYNTHETIC_KEY });
  const grants = Object.values(template.findResources("AWS::IAM::Policy")).flatMap(policy => policy.Properties.PolicyDocument.Statement)
    .filter(statement => JSON.stringify(statement.Action).includes("kms:"));
  assert.equal(grants.length, 2);
  for (const statement of grants) {
    assert.equal(statement.Resource, SYNTHETIC_KEY);
    assert.deepEqual([...statement.Action].sort(), ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey*", "kms:ReEncrypt*"].sort());
  }
  for (const task of Object.values(template.findResources("AWS::ECS::TaskDefinition"))) {
    const container = task.Properties.ContainerDefinitions[0];
    const key = container.Environment.find((entry: { Name: string }) => entry.Name === "KMS_KEY_ID");
    if (container.Name === "migration") assert.equal(key, undefined);
    else assert.equal(key.Value, SYNTHETIC_KEY);
  }
  assert.ok(!JSON.stringify(template.toJSON()).includes("kms:PutKeyPolicy"));
});

test("all and only six workload roles have exact names, individual boundaries and confused-deputy protection", t => {
  const { template } = production(t);
  template.resourceCountIs("AWS::IAM::Role", 6);
  template.resourceCountIs("AWS::IAM::ManagedPolicy", 0);
  const roles = template.findResources("AWS::IAM::Role");
  for (const workload of workloads) for (const kind of ["task", "execution"]) {
    const name = `admitflow-prod-${workload}-${kind}`;
    template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: name, Path: "/admitflow/workload/prod/",
      PermissionsBoundary: `arn:aws:iam::543777713748:policy/admitflow/boundaries/prod/${name}-boundary`,
      AssumeRolePolicyDocument: {
        Version: "2012-10-17", Statement: [{
          Action: "sts:AssumeRole", Effect: "Allow", Principal: { Service: "ecs-tasks.amazonaws.com" },
          Condition: { StringEquals: { "aws:SourceAccount": "543777713748" }, ArnLike: { "aws:SourceArn": "arn:aws:ecs:ap-southeast-1:543777713748:*" } },
        }],
      },
      ManagedPolicyArns: Match.absent(),
    });
  }
  for (const task of Object.values(template.findResources("AWS::ECS::TaskDefinition"))) {
    const family = task.Properties.Family;
    for (const [field, kind] of [["TaskRoleArn", "task"], ["ExecutionRoleArn", "execution"]]) {
      const roleId = task.Properties[field]["Fn::GetAtt"][0];
      assert.equal(roles[roleId].Properties.RoleName, `${family}-${kind}`);
    }
  }
  const migrationId = Object.keys(roles).find(id => roles[id].Properties.RoleName === "admitflow-prod-migration-task");
  assert.ok(migrationId);
  assert.equal(roles[migrationId].Properties.Policies, undefined);
  for (const policy of Object.values(template.findResources("AWS::IAM::Policy"))) {
    assert.ok(!policy.Properties.Roles.some((role: { Ref: string }) => role.Ref === migrationId), "migration task role must have no AWS grants");
  }
});

test("production queue keeps the stack and logical ID used by snapshot IAM scope", t => {
  const { stack, template } = production(t);
  assert.equal(stack.stackName, "AdmitFlow-prod");
  const queues = template.findResources("AWS::ElastiCache::ReplicationGroup");
  assert.deepEqual(Object.keys(queues), ["Queue"]);
  assert.equal(queues.Queue.DeletionPolicy, "Snapshot");
  assert.equal(queues.Queue.UpdateReplacePolicy, "Snapshot");
});

test("production resources keep approved fixed names, recovery settings and cost baseline", t => {
  const { template } = production(t);
  template.hasResourceProperties("AWS::ECR::Repository", { RepositoryName: "admitflow-prod", ImageTagMutability: "IMMUTABLE" });
  template.hasResourceProperties("AWS::ECS::Cluster", { ClusterName: "admitflow-prod" });
  template.hasResourceProperties("AWS::ElastiCache::SubnetGroup", { CacheSubnetGroupName: "admitflow-prod-queue-subnets" });
  template.resourceCountIs("AWS::ElastiCache::ParameterGroup", 0);
  template.hasResourceProperties("AWS::ElastiCache::ReplicationGroup", { CacheParameterGroupName: PRODUCTION.cacheParameterGroupName });
  template.hasOutput("CacheParameterGroupName", { Value: PRODUCTION.cacheParameterGroupName });
  template.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", { Name: "admitflow-prod-alb", IpAddressType: "ipv4", Scheme: "internet-facing" });
  template.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", { Name: "admitflow-prod-web" });
  template.hasResourceProperties("AWS::SecretsManager::Secret", { Name: "admitflow/prod/queue-auth", GenerateSecretString: { PasswordLength: 48 } });
  for (const name of ["web", "worker"]) template.hasResourceProperties("AWS::ECS::Service", { ServiceName: `admitflow-prod-${name}`, EnableExecuteCommand: false });
  template.hasResourceProperties("AWS::ElastiCache::ReplicationGroup", { ReplicationGroupId: "admitflow-prod-queue", NumCacheClusters: 1, AutomaticFailoverEnabled: false, MultiAZEnabled: false, SnapshotRetentionLimit: 3, SnapshotWindow: "18:00-19:00" });
  template.hasParameter("CacheNodeType", { Default: "cache.t4g.small" });
  template.hasParameter("WebDesiredCount", { Default: 1 });
  template.hasParameter("WorkerDesiredCount", { Default: 1 });
  template.resourceCountIs("AWS::EC2::Subnet", 4);
  template.resourceCountIs("AWS::EC2::NatGateway", 0);
  template.resourceCountIs("AWS::EC2::VPCEndpoint", 0);
  for (const resource of Object.values(template.findResources("AWS::ECS::TaskDefinition"))) {
    assert.equal(resource.Properties.Cpu, "256");
    assert.equal(resource.Properties.Memory, resource.Properties.Family.endsWith("migration") ? "512" : "1024");
  }
  for (const type of ["AWS::SecretsManager::Secret", "AWS::Logs::LogGroup", "AWS::ECR::Repository"]) {
    for (const resource of Object.values(template.findResources(type))) {
      assert.equal(resource.DeletionPolicy, "Retain");
      assert.equal(resource.UpdateReplacePolicy, "Retain");
    }
  }
  template.hasResource("AWS::ElastiCache::ReplicationGroup", { DeletionPolicy: "Snapshot", UpdateReplacePolicy: "Snapshot" });
  template.resourceCountIs("AWS::KMS::Key", 0);
  template.resourceCountIs("AWS::KMS::Alias", 0);
  template.resourceCountIs("AWS::CloudWatch::Alarm", 9);
  for (const workload of workloads) template.hasResourceProperties("AWS::Logs::LogGroup", { LogGroupName: `/admitflow/prod/${workload}`, RetentionInDays: 30 });
  template.hasResourceProperties("AWS::Logs::LogGroup", { LogGroupName: "/aws/vendedlogs/admitflow/prod/valkey", RetentionInDays: 30 });
});

test("production preserves secret selectors and requires exact application-secret name without invented suffix", t => {
  const { template } = production(t);
  template.hasParameter("DomainName", { AllowedValues: [PRODUCTION.domain] });
  const parameters = template.toJSON().Parameters;
  assert.equal(parameters.AppSecretArn.Default, undefined);
  const pattern = new RegExp(`^(?:${parameters.AppSecretArn.AllowedPattern})$`);
  assert.ok(pattern.test("arn:aws:secretsmanager:ap-southeast-1:543777713748:secret:admitflow/prod/application-Ab12cd"));
  for (const invalid of ["application", "other/application-Ab12cd", "admitflow/prod/application", "admitflow/prod/application-Ab12cd-extra"]) {
    assert.ok(!pattern.test(`arn:aws:secretsmanager:ap-southeast-1:543777713748:secret:${invalid}`));
  }
  for (const task of Object.values(template.findResources("AWS::ECS::TaskDefinition"))) {
    const container = task.Properties.ContainerDefinitions[0];
    const expected = container.Name === "migration" ? ["DATABASE_URL_UNPOOLED"] : [...SHARED_SECRET_KEYS, ...(container.Name === "web" ? WEB_SECRET_KEYS : []), "REDIS_PASSWORD"];
    assert.deepEqual(container.Secrets.map((secret: { Name: string }) => secret.Name).sort(), expected.sort());
    for (const secret of container.Secrets) assert.ok(JSON.stringify(secret.ValueFrom).includes(secret.Name === "REDIS_PASSWORD" ? ":password::" : `:${secret.Name}::`));
  }
});

test("privileged log policy is separate and cache still waits for its log group", t => {
  const { template } = production(t);
  template.resourceCountIs("AWS::Logs::ResourcePolicy", 0);
  const resources = template.toJSON().Resources;
  for (const resource of Object.values(resources) as { Type: string }[]) {
    assert.ok(!resource.Type.startsWith("Custom::"));
    assert.notEqual(resource.Type, "AWS::CloudFormation::CustomResource");
    assert.notEqual(resource.Type, "AWS::Lambda::Function");
  }
  const logId = Object.keys(template.findResources("AWS::Logs::LogGroup")).find(id => resources[id].Properties.LogGroupName === "/aws/vendedlogs/admitflow/prod/valkey");
  for (const cache of Object.values(template.findResources("AWS::ElastiCache::ReplicationGroup"))) assert.ok(cache.DependsOn.includes(logId));
  const policy = valkeyLogDeliveryPolicy();
  assert.equal(policy.policyName, "admitflow-prod-valkey-logs");
  assert.deepEqual(policy.policyDocument.Statement, [{
    Effect: "Allow", Principal: { Service: "delivery.logs.amazonaws.com" },
    Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
    Resource: "arn:aws:logs:ap-southeast-1:543777713748:log-group:/aws/vendedlogs/admitflow/prod/valkey:*",
    Condition: { StringEquals: { "aws:SourceAccount": "543777713748" }, ArnLike: { "aws:SourceArn": "arn:aws:logs:ap-southeast-1:543777713748:*" } },
  }]);
  assert.ok(!JSON.stringify(resources).includes("logs:PutResourcePolicy"));
});

test("production assembly uses both custom roles, no bootstrap assets/lookups and compact inline template", t => {
  const { app, stack } = production(t);
  const assembly = app.synth();
  const artifact = assembly.getStackArtifact(stack.artifactId);
  assert.equal(artifact.assumeRoleArn, PRODUCTION.deployRoleArn);
  assert.equal(artifact.cloudFormationExecutionRoleArn, PRODUCTION.cloudFormationExecutionRoleArn);
  assert.equal(assembly.manifest.missing, undefined);
  assert.equal(artifact.requiresBootstrapStackVersion, undefined);
  assert.equal(artifact.stackTemplateAssetObjectUrl, undefined);
  assert.ok(!Object.values(assembly.manifest.artifacts ?? {}).some(artifact => artifact.type === "cdk:asset-manifest"));
  assert.ok(!JSON.stringify(assembly.manifest).includes("cdk-hnb659fds"));
  const content = readFileSync(artifact.templateFullPath, "utf8");
  assert.equal(content, JSON.stringify(JSON.parse(content)));
  assert.ok(Buffer.byteLength(content) <= INLINE_TEMPLATE_LIMIT);
  assert.ok(!content.includes("BootstrapVersion"));
  t.diagnostic(`Compact production template: ${Buffer.byteLength(content)} UTF-8 bytes / ${INLINE_TEMPLATE_LIMIT}`);
});

test("inline guard rejects real oversized synthesis and measures UTF-8 exactly", t => {
  assert.equal(Buffer.byteLength(compactInlineTemplate("x".repeat(INLINE_TEMPLATE_LIMIT - 2))), INLINE_TEMPLATE_LIMIT);
  assert.throws(() => compactInlineTemplate("x".repeat(INLINE_TEMPLATE_LIMIT - 1)), /inline limit/);
  assert.throws(() => compactInlineTemplate("é".repeat(INLINE_TEMPLATE_LIMIT / 2)), /inline limit/);
  const app = application(t);
  const stack = configureApplication(app);
  new CfnResource(stack, "Oversize", { type: "AWS::CloudFormation::WaitConditionHandle" }).addMetadata("padding", "x".repeat(INLINE_TEMPLATE_LIMIT));
  assert.throws(() => app.synth(), /inline limit.*S3 transport/);
});

test("installed BootstraplessSynthesizer defaults are unsafe unless both role ARNs are supplied; assets forbidden", t => {
  for (const roles of [{}, { deployRoleArn: PRODUCTION.deployRoleArn }, { cloudFormationExecutionRoleArn: PRODUCTION.cloudFormationExecutionRoleArn }]) {
    const app = application(t);
    const synth = new BootstraplessSynthesizer(roles);
    const stack = new Stack(app, "Probe", { env: { account: PRODUCTION.account, region: PRODUCTION.region }, synthesizer: synth });
    new CfnResource(stack, "OfflineProbe", { type: "AWS::CloudFormation::WaitConditionHandle" });
    const artifact = app.synth().getStackArtifact(stack.artifactId);
    if (!("deployRoleArn" in roles)) assert.match(artifact.assumeRoleArn!, /cdk-hnb659fds-deploy-role/);
    if (!("cloudFormationExecutionRoleArn" in roles)) assert.match(artifact.cloudFormationExecutionRoleArn!, /cdk-hnb659fds-cfn-exec-role/);
  }
  const synth = new ScopedBootstraplessSynthesizer(PRODUCTION);
  new Stack(application(t), "AssetProbe", { env: { account: PRODUCTION.account, region: PRODUCTION.region }, synthesizer: synth });
  assert.throws(() => synth.addFileAsset({ sourceHash: "offline", fileName: "unused", packaging: FileAssetPackaging.FILE }), /Cannot add assets/);
  assert.throws(() => synth.addDockerImageAsset({ sourceHash: "offline", directoryName: "unused" }), /Cannot add assets/);
});

test("staging entrypoint stays explicitly offline and cannot accept production account/roles", t => {
  const app = application(t, {});
  const stack = configureApplication(app);
  const artifact = app.synth().getStackArtifact(stack.artifactId);
  assert.match(artifact.template.Description, /OFFLINE FIXTURE ONLY/);
  assert.equal(artifact.environment.account, "unknown-account");
  for (const input of [{ account: PRODUCTION.account }, { deployRoleArn: PRODUCTION.deployRoleArn }, { cloudFormationExecutionRoleArn: PRODUCTION.cloudFormationExecutionRoleArn }]) {
    assert.throws(() => configureApplication(application(t, input)), /offline fixture only/);
  }
});
