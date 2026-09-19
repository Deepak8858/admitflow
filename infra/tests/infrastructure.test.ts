import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AdmitFlowStack, SHARED_SECRET_KEYS, WEB_SECRET_KEYS } from "../stack";
import { prepareEnvironment } from "../entrypoint.mjs";
import { highAvailabilityContext } from "../context";

test("offline stack has TLS web/worker, isolated noeviction Valkey, secret selectors and digest-pinned images", async () => {
  const root = resolve("infra", ".test-output");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "cdk-"));
  try {
    const app = new App({ outdir: directory });
    const stack = new AdmitFlowStack(app, "OfflineTest", { stage: "test", env: { region: "ap-southeast-1" }, availabilityZones: ["ap-southeast-1a", "ap-southeast-1b"] });
    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::ECS::Service", 2);
    template.resourceCountIs("AWS::ECS::TaskDefinition", 3);
    template.resourceCountIs("AWS::ECR::Repository", 1);
    template.resourceCountIs("AWS::EC2::NatGateway", 0);
    template.resourceCountIs("AWS::S3::Bucket", 0);
    template.resourceCountIs("AWS::ElastiCache::ServerlessCache", 0);
    template.hasResourceProperties("AWS::ElastiCache::ParameterGroup", { CacheParameterGroupFamily: "valkey7", Properties: { "maxmemory-policy": "noeviction" } });
    template.hasResourceProperties("AWS::ElastiCache::ReplicationGroup", { Engine: "valkey", TransitEncryptionEnabled: true, TransitEncryptionMode: "required", AtRestEncryptionEnabled: true, ReplicasPerNodeGroup: 0, AuthToken: Match.anyValue() });
    template.hasResourceProperties("AWS::KMS::Key", { EnableKeyRotation: true });
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", { Port: 443, Protocol: "HTTPS", SslPolicy: "ELBSecurityPolicy-TLS13-1-2-2021-06", Certificates: [{ CertificateArn: { Ref: "CertificateArn" } }] });
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", { HealthCheckPath: "/api/health", Port: 3000 });
    template.hasResourceProperties("AWS::ECS::Service", { NetworkConfiguration: { AwsvpcConfiguration: { AssignPublicIp: "ENABLED", SecurityGroups: Match.anyValue(), Subnets: Match.anyValue() } } });
    for (const resource of Object.values(template.findResources("AWS::ECS::TaskDefinition"))) {
      for (const container of resource.Properties.ContainerDefinitions) {
        assert.match(JSON.stringify(container.Image), /@/, "digest tokens must not be rendered as ECR tags");
        const environment = new Map(container.Environment.map((entry: { Name: string; Value: string }) => [entry.Name, entry.Value]));
        assert(!environment.has("DATABASE_URL"));
        assert(!environment.has("DATABASE_URL_UNPOOLED"));
        assert(!environment.has("REDIS_PASSWORD"));
        assert(!environment.has("REDIS_URL"));
        assert(container.Secrets.length > 0);
        if (container.Name === "worker") {
          const selected = new Map(container.Secrets.map((entry: { Name: string; ValueFrom: unknown }) => [entry.Name, entry.ValueFrom]));
          for (const key of ["BILLING_RAZORPAY_KEY_ID", "BILLING_RAZORPAY_KEY_SECRET", "BILLING_PLANS_JSON"]) {
            assert(selected.has(key), `Worker subscription reconciliation needs ${key}`);
            assert(!environment.has(key), `${key} must be a secret selector, not plaintext environment`);
            assert(JSON.stringify(selected.get(key)).includes(key));
          }
          assert(!selected.has("BILLING_RAZORPAY_WEBHOOK_SECRET"));
          assert(!selected.has("WORKOS_API_KEY"));
        }
      }
    }
    for (const resource of Object.values(template.findResources("AWS::EC2::SecurityGroupIngress"))) {
      if ([3000, 6379].includes(resource.Properties.ToPort)) assert(resource.Properties.SourceSecurityGroupId, "application and queue ports must only accept security-group sources");
    }
    const secret = JSON.parse(await readFile(resolve("infra/application-secret.example.json"), "utf8"));
    assert.deepEqual(Object.keys(secret).sort(), [...new Set([...SHARED_SECRET_KEYS, ...WEB_SECRET_KEYS, "DATABASE_URL_UNPOOLED"])].sort());
    assert(Object.values(secret).every(value => value === "" || value === "[]"));
    assert.equal(app.synth().manifest.missing, undefined, "offline synthesis must not request AWS context lookups");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("HA context accepts boolean and CLI forms and synthesizes matching service/cache availability", async () => {
  for (const value of [null, 0, 1, "", "TRUE", "yes", [], {}]) assert.throws(() => highAvailabilityContext(value), /highAvailability/);
  const root = resolve("infra", ".test-output");
  await mkdir(root, { recursive: true });
  for (const [value, expected] of [[undefined, false], [false, false], ["false", false], [true, true], ["true", true]] as const) {
    const directory = await mkdtemp(join(root, "cdk-ha-"));
    try {
      const app = new App({ outdir: directory, context: value === undefined ? {} : { highAvailability: value } });
      const highAvailability = highAvailabilityContext(app.node.tryGetContext("highAvailability"));
      assert.equal(highAvailability, expected);
      const stack = new AdmitFlowStack(app, "AvailabilityTest", { stage: "test", env: { region: "ap-southeast-1" }, availabilityZones: ["ap-southeast-1a", "ap-southeast-1b"], highAvailability });
      const template = Template.fromStack(stack);
      template.hasParameter("WebDesiredCount", { Default: expected ? 2 : 1 });
      template.hasResourceProperties("AWS::ECS::Service", { DesiredCount: { Ref: "WebDesiredCount" } });
      template.hasResourceProperties("AWS::ElastiCache::ReplicationGroup", { ReplicasPerNodeGroup: expected ? 1 : 0, AutomaticFailoverEnabled: expected, MultiAZEnabled: expected });
      assert.equal(app.synth().manifest.missing, undefined);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("entrypoint translates secret injection into TLS REDIS_URL without persisting the password field", () => {
  const env = prepareEnvironment({ ADMITFLOW_PROCESS_ROLE: "worker", DATABASE_URL: "postgres://test", REDIS_HOST: "queue.internal", REDIS_PORT: "6379", REDIS_PASSWORD: "test:/@password", REDIS_TLS: "true" });
  const url = new URL(env.REDIS_URL);
  assert.equal(url.protocol, "rediss:");
  assert.equal(url.hostname, "queue.internal");
  assert.equal(decodeURIComponent(url.password), "test:/@password");
  assert(!("REDIS_PASSWORD" in env));
  assert.throws(() => prepareEnvironment({ ADMITFLOW_PROCESS_ROLE: "web" }), /DATABASE_URL/);
  assert.throws(() => prepareEnvironment({ ADMITFLOW_PROCESS_ROLE: "worker", DATABASE_URL: "postgres://test", REDIS_HOST: "queue.internal", REDIS_PASSWORD: "test", REDIS_TLS: "false" }), /REDIS_TLS/);
});
