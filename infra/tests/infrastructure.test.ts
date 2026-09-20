import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AdmitFlowStack, SHARED_SECRET_KEYS, WEB_SECRET_KEYS } from "../stack";
import { prepareEnvironment } from "../entrypoint.mjs";
import { highAvailabilityContext } from "../context";

type IngressRule = { GroupId?: unknown; SourceSecurityGroupId?: unknown; CidrIp?: unknown; CidrIpv6?: unknown; SourcePrefixListId?: unknown; IpProtocol?: string; FromPort?: number; ToPort?: number };

function assertProtectedIngress(template: Template) {
  const groups = template.findResources("AWS::EC2::SecurityGroup");
  const reference = (name: string) => {
    const ids = Object.keys(groups).filter(id => id.startsWith(name));
    assert.equal(ids.length, 1, `expected one ${name}`);
    return { "Fn::GetAtt": [ids[0], "GroupId"] };
  };
  // CDK may inline CIDR rules while keeping SG-to-SG rules separate. Inspect both.
  const ingress: IngressRule[] = [
    ...Object.values(template.findResources("AWS::EC2::SecurityGroupIngress")).map(resource => resource.Properties),
    ...Object.entries(groups).flatMap(([id, resource]) => (resource.Properties.SecurityGroupIngress ?? []).map((rule: IngressRule) => ({ ...rule, GroupId: { "Fn::GetAtt": [id, "GroupId"] } }))),
  ];
  for (const rule of ingress) {
    if (rule.CidrIp === undefined && rule.CidrIpv6 === undefined && rule.SourcePrefixListId === undefined) continue;
    assert.deepEqual(rule.GroupId, reference("AlbSecurityGroup"), "CIDR ingress is allowed only on the ALB");
    assert.equal(rule.SourcePrefixListId, undefined, "prefix-list ingress is not allowed");
    assert.equal(rule.SourceSecurityGroupId, undefined, "public ingress must not mix source types");
    assert.equal(rule.IpProtocol, "tcp", "public ingress must use TCP");
    assert.ok(rule.FromPort === 80 || rule.FromPort === 443, "public ingress must use port 80 or 443");
    assert.equal(rule.ToPort, rule.FromPort, "public ingress must not span a port range");
  }
  const expected = new Map([
    [3000, [["WebSecurityGroup", "AlbSecurityGroup"]]],
    [6379, [["CacheSecurityGroup", "CacheSecurityGroup"], ["CacheSecurityGroup", "WebSecurityGroup"], ["CacheSecurityGroup", "WorkerSecurityGroup"]]],
  ]);
  for (const [port, edges] of expected) {
    const rules = ingress.filter(rule => rule.IpProtocol === "-1" || (typeof rule.FromPort === "number" && typeof rule.ToPort === "number" && rule.FromPort <= port && rule.ToPort >= port));
    assert.equal(rules.length, edges.length, `port ${port} must have every expected SG ingress rule and no others`);
    for (const rule of rules) {
      assert.equal(rule.IpProtocol, "tcp"); assert.equal(rule.FromPort, port); assert.equal(rule.ToPort, port);
      assert.ok(rule.SourceSecurityGroupId, `port ${port} requires an SG source`);
      assert.equal(rule.CidrIp, undefined); assert.equal(rule.CidrIpv6, undefined); assert.equal(rule.SourcePrefixListId, undefined);
    }
    assert.deepEqual(rules.map(rule => JSON.stringify([rule.GroupId, rule.SourceSecurityGroupId])).sort(), edges.map(([target, source]) => JSON.stringify([reference(target), reference(source)])).sort());
  }
}

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
    template.hasResourceProperties("AWS::ElastiCache::ReplicationGroup", { Engine: "valkey", TransitEncryptionEnabled: true, TransitEncryptionMode: "required", AtRestEncryptionEnabled: true, ClusterMode: "disabled", NumCacheClusters: 1, AuthToken: Match.anyValue() });
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
    assertProtectedIngress(template);
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
      const nodes = expected ? 2 : 1;
      template.hasResourceProperties("AWS::ElastiCache::ReplicationGroup", { ClusterMode: "disabled", NumCacheClusters: nodes, NumNodeGroups: Match.absent(), ReplicasPerNodeGroup: Match.absent(), AutomaticFailoverEnabled: expected, MultiAZEnabled: expected });
      const cacheIds = Object.keys(template.findResources("AWS::ElastiCache::ReplicationGroup"));
      assert.equal(cacheIds.length, 1);
      const queueAlarms = Object.values(template.findResources("AWS::CloudWatch::Alarm")).filter(resource => resource.Properties.Namespace === "AWS/ElastiCache");
      assert.equal(queueAlarms.length, nodes * 2);
      for (const metric of ["DatabaseMemoryUsagePercentage", "Evictions"]) {
        const alarms = queueAlarms.filter(resource => resource.Properties.MetricName === metric);
        assert.equal(alarms.length, nodes);
        for (let index = 1; index <= nodes; index++) {
          const dimensions = { CacheClusterId: { "Fn::Join": ["", [{ Ref: cacheIds[0] }, `-${String(index).padStart(3, "0")}`]] }, CacheNodeId: "0001" };
          assert.equal(alarms.filter(resource => JSON.stringify(Object.fromEntries(resource.Properties.Dimensions.map((dimension: { Name: string; Value: unknown }) => [dimension.Name, dimension.Value]))) === JSON.stringify(dimensions)).length, 1);
        }
      }
      for (const resource of Object.values(template.findResources("AWS::ECS::TaskDefinition"))) {
        for (const container of resource.Properties.ContainerDefinitions) if (["web", "worker"].includes(container.Name)) {
          const environment = Object.fromEntries(container.Environment.map((entry: { Name: string; Value: unknown }) => [entry.Name, entry.Value]));
          assert.deepEqual(environment.REDIS_HOST, { "Fn::GetAtt": [cacheIds[0], "PrimaryEndPoint.Address"] });
          assert.deepEqual(environment.REDIS_PORT, { "Fn::GetAtt": [cacheIds[0], "PrimaryEndPoint.Port"] });
        }
      }
      assertProtectedIngress(template);
      assert.equal(app.synth().manifest.missing, undefined);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("protected ingress assertions reject missing, public, ranged and wrong-SG rules in either CDK representation", () => {
  const groupNames = ["AlbSecurityGroup", "WebSecurityGroup", "WorkerSecurityGroup", "CacheSecurityGroup"];
  const groups = Object.fromEntries(groupNames.map(name => [name, { Type: "AWS::EC2::SecurityGroup", Properties: {} }]));
  const rule = (target: string, source: string, port: number): IngressRule => ({ GroupId: { "Fn::GetAtt": [target, "GroupId"] }, SourceSecurityGroupId: { "Fn::GetAtt": [source, "GroupId"] }, IpProtocol: "tcp", FromPort: port, ToPort: port });
  const rules = [rule("WebSecurityGroup", "AlbSecurityGroup", 3000), ...["CacheSecurityGroup", "WebSecurityGroup", "WorkerSecurityGroup"].map(source => rule("CacheSecurityGroup", source, 6379))];
  const template = (ingress: IngressRule[], inline: boolean) => {
    const resources = structuredClone(groups);
    if (inline) {
      const isSelfRule = (entry: IngressRule) => JSON.stringify(entry.GroupId) === JSON.stringify(entry.SourceSecurityGroupId);
      for (const name of groupNames) resources[name].Properties = { SecurityGroupIngress: ingress.filter(entry => !isSelfRule(entry) && JSON.stringify(entry.GroupId) === JSON.stringify({ "Fn::GetAtt": [name, "GroupId"] })).map(({ GroupId: _group, ...entry }) => entry) };
      // Like CDK, keep self-references standalone to avoid a CloudFormation cycle.
      const selfRules = Object.fromEntries(ingress.filter(isSelfRule).map((entry, index) => [`SelfIngress${index}`, { Type: "AWS::EC2::SecurityGroupIngress", Properties: entry }]));
      return Template.fromJSON({ Resources: { ...resources, ...selfRules } });
    }
    return Template.fromJSON({ Resources: { ...resources, ...Object.fromEntries(ingress.map((entry, index) => [`Ingress${index}`, { Type: "AWS::EC2::SecurityGroupIngress", Properties: entry }])) } });
  };
  for (const inline of [false, true]) {
    assertProtectedIngress(template(rules, inline));
    const publicRule = (target: string, port: number, source: Partial<IngressRule>): IngressRule => ({ GroupId: { "Fn::GetAtt": [target, "GroupId"] }, IpProtocol: "tcp", FromPort: port, ToPort: port, ...source });
    const publicSources = [{ CidrIp: "0.0.0.0/0" }, { CidrIpv6: "::/0" }];
    const albRules = publicSources.flatMap(source => [80, 443].map(port => publicRule("AlbSecurityGroup", port, source)));
    assertProtectedIngress(template([...rules, ...albRules], inline));
    for (const target of groupNames) {
      for (const source of [...publicSources, { SourcePrefixListId: "pl-test" }]) {
        assert.throws(() => assertProtectedIngress(template([...rules, publicRule(target, 5432, source)], inline)));
        if (target !== "AlbSecurityGroup" || "SourcePrefixListId" in source) {
          for (const port of [80, 443]) assert.throws(() => assertProtectedIngress(template([...rules, publicRule(target, port, source)], inline)));
        }
      }
    }
    for (const replacement of [{ FromPort: 22, ToPort: 22 }, { FromPort: 80, ToPort: 443 }, { IpProtocol: "udp" }, { IpProtocol: "-1" }]) {
      assert.throws(() => assertProtectedIngress(template([...rules, { ...publicRule("AlbSecurityGroup", 80, { CidrIp: "0.0.0.0/0" }), ...replacement }], inline)));
    }
    for (const port of [3000, 6379]) {
      assert.throws(() => assertProtectedIngress(template(rules.filter(entry => entry.ToPort !== port), inline)));
      for (const replacement of [
        { SourceSecurityGroupId: undefined, CidrIp: "0.0.0.0/0" },
        { SourceSecurityGroupId: undefined, CidrIpv6: "::/0" },
        { SourceSecurityGroupId: { "Fn::GetAtt": ["WorkerSecurityGroup", "GroupId"] } },
        { FromPort: 1, ToPort: 65535 },
      ]) assert.throws(() => assertProtectedIngress(template(rules.map((entry, index) => index === (port === 3000 ? 0 : 1) ? { ...entry, ...replacement } : entry), inline)));
    }
  }
});

test("entrypoint translates secret injection into TLS REDIS_URL without persisting the password field", () => {
  const INTAKE_CONTACT_KEYS = JSON.stringify([Buffer.alloc(32, 17).toString("base64")]);
  const env = prepareEnvironment({ ADMITFLOW_PROCESS_ROLE: "worker", DATABASE_URL: "postgres://test", INTAKE_CONTACT_KEYS, REDIS_HOST: "queue.internal", REDIS_PORT: "6379", REDIS_PASSWORD: "test:/@password", REDIS_TLS: "true" });
  const url = new URL(env.REDIS_URL);
  assert.equal(url.protocol, "rediss:");
  assert.equal(url.hostname, "queue.internal");
  assert.equal(decodeURIComponent(url.password), "test:/@password");
  assert(!("REDIS_PASSWORD" in env));
  assert.throws(() => prepareEnvironment({ ADMITFLOW_PROCESS_ROLE: "web" }), /DATABASE_URL/);
  assert.throws(() => prepareEnvironment({ ADMITFLOW_PROCESS_ROLE: "worker", DATABASE_URL: "postgres://test", INTAKE_CONTACT_KEYS, REDIS_HOST: "queue.internal", REDIS_PASSWORD: "test", REDIS_TLS: "false" }), /REDIS_TLS/);
  for (const value of ["", "[]", "bad", JSON.stringify(["short"])]) assert.throws(() => prepareEnvironment({ ADMITFLOW_PROCESS_ROLE: "worker", DATABASE_URL: "postgres://test", INTAKE_CONTACT_KEYS: value, REDIS_HOST: "queue.internal", REDIS_PASSWORD: "test", REDIS_TLS: "true" }), /INTAKE_CONTACT_KEYS/);
});
