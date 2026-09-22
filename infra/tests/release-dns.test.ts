import test from "node:test";
import assert from "node:assert/strict";
import type { spawnSync } from "node:child_process";
import type { Resolver } from "node:dns/promises";
import type { request } from "node:https";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { apply, CONTRACT, fingerprint, parseArgs, preview, validateOptions } from "../../scripts/release-dns.mjs";
import { cliEnvironment, cliTransport, networkChecks, probeHttps } from "../../scripts/release-dns-transport.mjs";

const certArn = `arn:aws:acm:${CONTRACT.region}:${CONTRACT.account}:certificate/12345678-1234-1234-1234-123456789abc`;
const albArn = `arn:aws:elasticloadbalancing:${CONTRACT.region}:${CONTRACT.account}:loadbalancer/app/admitflow-prod-alb/1234abcd`;
const groupArn = `arn:aws:elasticloadbalancing:${CONTRACT.region}:${CONTRACT.account}:targetgroup/admitflow-prod-web/abcd1234`;
const validationName = `_${"a".repeat(32)}.${CONTRACT.app}`;
const validationValue = `_${"b".repeat(32)}.acm-validations.aws.`;
const options = { profile: "admitflow-dns-operator", phase: "validation", certificateArn: certArn };
const appOptions = { ...options, phase: "application", acceptRelease: "c".repeat(64) };
const now = Date.parse("2026-09-20T16:00:00Z");

type ResponseMap = Record<string, any>;
function fixture() {
  const responses: ResponseMap = {
    "get-caller-identity": { Account: CONTRACT.account, Arn: `arn:aws:sts::${CONTRACT.account}:assumed-role/admitflow-prod-bootstrap/operator` },
    "get-hosted-zone": { HostedZone: { Id: `/hostedzone/${CONTRACT.zone}`, Name: CONTRACT.zoneName, Config: { PrivateZone: false } }, DelegationSet: { NameServers: ["ns-1.awsdns.com", "ns-2.awsdns.net"] } },
    "describe-certificate": { Certificate: { CertificateArn: certArn, Type: "AMAZON_ISSUED", DomainName: CONTRACT.app.slice(0, -1), SubjectAlternativeNames: [CONTRACT.app.slice(0, -1)], Status: "ISSUED", NotAfter: "2027-09-20T00:00:00Z", DomainValidationOptions: [{ DomainName: CONTRACT.app.slice(0, -1), ValidationMethod: "DNS", ResourceRecord: { Name: validationName, Type: "CNAME", Value: validationValue } }] } },
    "list-resource-record-sets": { IsTruncated: false, ResourceRecordSets: [
      { Name: CONTRACT.zoneName, Type: "MX", TTL: 300, ResourceRecords: [{ Value: "1 mail.example.net." }] },
      { Name: CONTRACT.zoneName, Type: "A", AliasTarget: { DNSName: "site.cloudfront.net.", HostedZoneId: "ZAPEX", EvaluateTargetHealth: false } },
      { Name: CONTRACT.zoneName, Type: "AAAA", AliasTarget: { DNSName: "site.cloudfront.net.", HostedZoneId: "ZAPEX", EvaluateTargetHealth: false } },
      { Name: CONTRACT.zoneName, Type: "NS", TTL: 172800, ResourceRecords: [{ Value: "ns-1.awsdns.com." }] },
      { Name: CONTRACT.zoneName, Type: "SOA", TTL: 900, ResourceRecords: [{ Value: "ns-1.awsdns.com. hostmaster.example.net. 1 7200 900 1209600 86400" }] },
      { Name: "unrelated.incfrog.ai.", Type: "TXT", TTL: 300, ResourceRecords: [{ Value: '"unrelated-private-text"' }] },
    ] },
    "describe-load-balancers": { LoadBalancers: [{ LoadBalancerArn: albArn, LoadBalancerName: CONTRACT.alb, Type: "application", Scheme: "internet-facing", State: { Code: "active" }, DNSName: "admitflow-prod-alb-123456.ap-southeast-1.elb.amazonaws.com", CanonicalHostedZoneId: "ZREALAWSZONE", IpAddressType: "ipv4" }] },
    "describe-listeners": { Listeners: [{ LoadBalancerArn: albArn, Port: 443, Protocol: "HTTPS", Certificates: [{ CertificateArn: certArn }] }] },
    "describe-target-groups": { TargetGroups: [{ TargetGroupArn: groupArn, TargetGroupName: CONTRACT.targetGroup, LoadBalancerArns: [albArn], HealthCheckPath: "/api/health" }] },
    "describe-target-health": { TargetHealthDescriptions: [{ TargetHealth: { State: "healthy" } }] },
    "describe-services": { failures: [], services: ["web", "worker"].map(role => ({ serviceName: `admitflow-prod-${role}`, clusterArn: `arn:aws:ecs:${CONTRACT.region}:${CONTRACT.account}:cluster/admitflow-prod`, serviceArn: `arn:aws:ecs:${CONTRACT.region}:${CONTRACT.account}:service/admitflow-prod/admitflow-prod-${role}`, status: "ACTIVE", desiredCount: 1, runningCount: 1, pendingCount: 0, taskDefinition: `arn:aws:ecs:${CONTRACT.region}:${CONTRACT.account}:task-definition/admitflow-prod-${role}:1`, loadBalancers: role === "web" ? [{ targetGroupArn: groupArn, containerName: "web", containerPort: 3000 }] : [], deployments: [{ status: "PRIMARY", rolloutState: "COMPLETED" }] })) },
    "change-resource-record-sets": { ChangeInfo: { Id: "/change/C123", Status: "PENDING" } },
    "get-change": { ChangeInfo: { Id: "/change/C123", Status: "INSYNC" } },
  };
  const calls: { service: string; operation: string; input: any }[] = [];
  const io = { now: () => now, sleep: async (_ms: number) => {}, call: async (service: string, operation: string, input: any) => { calls.push({ service, operation, input }); const response = responses[operation]; if (response instanceof Error) throw response; if (typeof response === "function") return response(input); assert(response, `Unexpected operation ${operation}`); return structuredClone(response); } };
  const checks = { delegation: async () => true, https: async () => true, public: async (_state: any) => ({ status: "VERIFIED" }) };
  return { responses, calls, io, checks };
}
const writes = (f: ReturnType<typeof fixture>) => f.calls.filter(call => call.operation === "change-resource-record-sets");

test("default preview is read-only and preserves unrelated records without printing their data", async () => {
  const f = fixture(), result = await preview(options, f.io, f.checks);
  assert.equal(writes(f).length, 0);
  assert.deepEqual(result.state.changes, [{ Action: "CREATE", ResourceRecordSet: { Name: validationName, Type: "CNAME", TTL: 300, ResourceRecords: [{ Value: validationValue }] } }]);
  assert(!JSON.stringify(result).includes("unrelated-private-text"));
  assert.equal(result.fingerprint, fingerprint({ createdAt: now, state: result.state }));
});

const invalid: [string, (r: ResponseMap) => void, string][] = [
  ["wrong account", r => r["get-caller-identity"].Account = "111111111111", "account"],
  ["root identity", r => r["get-caller-identity"].Arn = `arn:aws:iam::${CONTRACT.account}:root`, "non-root"],
  ["foreign identity ARN", r => r["get-caller-identity"].Arn = "arn:aws:iam::111111111111:user/foo", "non-root"],
  ["private zone", r => r["get-hosted-zone"].HostedZone.Config.PrivateZone = true, "public hosted zone"],
  ["wrong zone ID", r => r["get-hosted-zone"].HostedZone.Id = "/hostedzone/ZOTHER", "public hosted zone"],
  ["wrong zone name", r => r["get-hosted-zone"].HostedZone.Name = "example.com", "public hosted zone"],
  ["foreign certificate", r => r["describe-certificate"].Certificate.CertificateArn = certArn.replace(CONTRACT.account, "111111111111"), "exact-domain"],
  ["wrong certificate region", r => r["describe-certificate"].Certificate.CertificateArn = certArn.replace(CONTRACT.region, "us-east-1"), "exact-domain"],
  ["wrong domain", r => r["describe-certificate"].Certificate.DomainName = "incfrog.ai", "exact-domain"],
  ["wildcard SAN", r => r["describe-certificate"].Certificate.SubjectAlternativeNames = ["*.incfrog.ai"], "exact-domain"],
  ["extra SAN", r => r["describe-certificate"].Certificate.SubjectAlternativeNames.push("www.incfrog.ai"), "exact-domain"],
  ["imported cert", r => r["describe-certificate"].Certificate.Type = "IMPORTED", "exact-domain"],
  ["revoked cert", r => r["describe-certificate"].Certificate.Status = "REVOKED", "exact-domain"],
  ["missing validation CNAME", r => delete r["describe-certificate"].Certificate.DomainValidationOptions[0].ResourceRecord, "actual acm"],
  ["wrong validation name", r => r["describe-certificate"].Certificate.DomainValidationOptions[0].ResourceRecord.Name = `_${"a".repeat(32)}.incfrog.ai`, "validation name"],
  ["wrong validation domain", r => r["describe-certificate"].Certificate.DomainValidationOptions[0].DomainName = "other.incfrog.ai", "actual acm"],
  ["arbitrary target", r => r["describe-certificate"].Certificate.DomainValidationOptions[0].ResourceRecord.Value = "attacker.example", "validation name"],
  ["email validation", r => r["describe-certificate"].Certificate.DomainValidationOptions[0].ValidationMethod = "EMAIL", "actual acm"],
];
for (const [name, mutate, error] of invalid) test(`rejects ${name} without writes`, async () => { const f = fixture(); mutate(f.responses); await assert.rejects(preview(options, f.io, f.checks), new RegExp(error, "i")); assert.equal(writes(f).length, 0); });

for (const name of [CONTRACT.app, validationName]) test(`rejects delegation at ${name}`, async () => {
  const f = fixture(); f.responses["list-resource-record-sets"].ResourceRecordSets.push({ Name: name, Type: "NS", TTL: 300, ResourceRecords: [{ Value: "ns.attacker.example." }] });
  await assert.rejects(preview(options, f.io, f.checks), /delegation/);
});

test("rejects public delegation mismatch", async () => { const f = fixture(); f.checks.delegation = async () => false; await assert.rejects(preview(options, f.io, f.checks), /delegation/); });
for (const type of ["CNAME", "TXT", "A"]) test(`rejects conflicting validation ${type}`, async () => {
  const f = fixture(); f.responses["list-resource-record-sets"].ResourceRecordSets.push({ Name: validationName, Type: type, TTL: 300, ResourceRecords: [{ Value: "elsewhere.example." }] });
  await assert.rejects(preview(options, f.io, f.checks), /Conflicting/);
});

test("matching exact records are idempotent no-ops", async () => {
  for (const opts of [options, appOptions]) {
    const f = fixture(), first = await preview(opts, f.io, f.checks);
    f.responses["list-resource-record-sets"].ResourceRecordSets.push(...first.state.desired);
    const plan = await preview(opts, f.io, f.checks);
    assert.equal(plan.state.changes.length, 0);
    assert.equal((await apply(plan, plan.fingerprint, opts, f.io, f.checks)).submission, "NOOP");
    assert.equal(writes(f).length, 0);
  }
});

test("IPv4 ALB yields only A, dualstack yields A and AAAA with AWS canonical zone", async () => {
  for (const mode of ["ipv4", "dualstack"]) {
    const f = fixture(); f.responses["describe-load-balancers"].LoadBalancers[0].IpAddressType = mode;
    const plan = await preview(appOptions, f.io, f.checks);
    assert.deepEqual(plan.state.desired.map((r: any) => r.Type), mode === "ipv4" ? ["A"] : ["A", "AAAA"]);
    for (const r of plan.state.desired as any[]) assert.equal(r.AliasTarget.HostedZoneId, "ZREALAWSZONE");
  }
});

const badApp: [string, (r: ResponseMap) => void][] = [
  ["foreign ALB", r => r["describe-load-balancers"].LoadBalancers[0].LoadBalancerArn = albArn.replace(CONTRACT.account, "111111111111")],
  ["wrong ALB region", r => r["describe-load-balancers"].LoadBalancers[0].LoadBalancerArn = albArn.replace(CONTRACT.region, "us-east-1")],
  ["wrong ALB name", r => r["describe-load-balancers"].LoadBalancers[0].LoadBalancerName = "other"],
  ["internal ALB", r => r["describe-load-balancers"].LoadBalancers[0].Scheme = "internal"],
  ["inactive ALB", r => r["describe-load-balancers"].LoadBalancers[0].State.Code = "provisioning"],
  ["arbitrary ALB DNS", r => r["describe-load-balancers"].LoadBalancers[0].DNSName = "attacker.example"],
  ["invalid canonical zone", r => r["describe-load-balancers"].LoadBalancers[0].CanonicalHostedZoneId = ""],
  ["IPv6-only unsupported ALB", r => r["describe-load-balancers"].LoadBalancers[0].IpAddressType = "dualstack-without-public-ipv4"],
  ["unissued certificate", r => r["describe-certificate"].Certificate.Status = "PENDING_VALIDATION"],
  ["expired certificate", r => r["describe-certificate"].Certificate.NotAfter = "2026-01-01T00:00:00Z"],
  ["wrong target group", r => r["describe-target-groups"].TargetGroups[0].LoadBalancerArns = [albArn + "bad"]],
  ["unhealthy target", r => r["describe-target-health"].TargetHealthDescriptions[0].TargetHealth.State = "unhealthy"],
  ["empty targets", r => r["describe-target-health"].TargetHealthDescriptions = []],
  ["zero worker", r => r["describe-services"].services[1].desiredCount = 0],
  ["incomplete deployment", r => r["describe-services"].services[0].deployments[0].rolloutState = "IN_PROGRESS"],
  ["different cluster", r => r["describe-services"].services[0].clusterArn += "-other"],
  ["wrong listener certificate", r => r["describe-listeners"].Listeners[0].Certificates[0].CertificateArn += "bad"],
  ["HTTP-only listener", r => r["describe-listeners"].Listeners[0].Protocol = "HTTP"],
  ["unrelated task family", r => r["describe-services"].services[0].taskDefinition = "arn:aws:ecs:ap-southeast-1:543777713748:task-definition/unrelated:1"],
];
for (const [name, mutate] of badApp) test(`application rejects ${name}`, async () => { const f = fixture(); mutate(f.responses); await assert.rejects(preview(appOptions, f.io, f.checks)); assert.equal(writes(f).length, 0); });

for (const [label, binding] of [
  ["missing", undefined],
  ["empty", []],
  ["wrong group", [{ targetGroupArn: groupArn + "bad", containerName: "web", containerPort: 3000 }]],
  ["wrong container", [{ targetGroupArn: groupArn, containerName: "worker", containerPort: 3000 }]],
  ["wrong port", [{ targetGroupArn: groupArn, containerName: "web", containerPort: 80 }]],
  ["split fields", [{ targetGroupArn: groupArn, containerName: "worker", containerPort: 3000 }, { targetGroupArn: groupArn + "bad", containerName: "web", containerPort: 3000 }]],
] as const) test(`web target association rejects ${label} on preview and fresh apply`, async () => {
  const f = fixture(), plan = await preview(appOptions, f.io, f.checks);
  f.responses["describe-services"].services[0].loadBalancers = binding;
  await assert.rejects(preview(appOptions, f.io, f.checks), /Web service must bind/);
  await assert.rejects(apply(plan, plan.fingerprint, appOptions, f.io, f.checks), /Web service must bind/);
  assert.equal(writes(f).length, 0);
});

test("application requires release acknowledgment and direct TLS health/readiness", async () => {
  const f = fixture(); await assert.rejects(preview({ ...appOptions, acceptRelease: "" }, f.io, f.checks), /release-acceptance/);
  f.checks.https = async () => false; await assert.rejects(preview(appOptions, f.io, f.checks), /TLS/);
});

test("existing unsupported AAAA or non-alias A blocks IPv4 application", async () => {
  for (const Type of ["AAAA", "A"]) { const f = fixture(); f.responses["list-resource-record-sets"].ResourceRecordSets.push({ Name: CONTRACT.app, Type, TTL: 300, ResourceRecords: [{ Value: "192.0.2.1" }] }); await assert.rejects(preview(appOptions, f.io, f.checks), /Conflicting/); }
});

test("apply binds exact reviewed fingerprint, options, age and all live records", async () => {
  const f = fixture(), plan = await preview(options, f.io, f.checks);
  await assert.rejects(apply(plan, "d".repeat(64), options, f.io, f.checks), /fingerprint/);
  await assert.rejects(apply({ ...plan, createdAt: now - 1 }, plan.fingerprint, options, f.io, f.checks), /fingerprint/);
  await assert.rejects(apply(plan, plan.fingerprint, { ...options, profile: "different" }, f.io, f.checks), /options/);
  await assert.rejects(apply(plan, plan.fingerprint, options, { ...f.io, now: () => now + 900_001 }, f.checks), /expired/);
  f.responses["list-resource-record-sets"].ResourceRecordSets.push({ Name: "another.incfrog.ai.", Type: "TXT", TTL: 60, ResourceRecords: [{ Value: '"new"' }] });
  await assert.rejects(apply(plan, plan.fingerprint, options, f.io, f.checks), /Live state changed/);
  assert.equal(writes(f).length, 0);
});

test("apply revalidates health and target after preview", async () => {
  const f = fixture(), plan = await preview(appOptions, f.io, f.checks);
  f.checks.https = async () => false;
  await assert.rejects(apply(plan, plan.fingerprint, appOptions, f.io, f.checks), /TLS/);
  f.checks.https = async () => true; f.responses["describe-load-balancers"].LoadBalancers[0].DNSName = "admitflow-prod-alb-999.ap-southeast-1.elb.amazonaws.com";
  await assert.rejects(apply(plan, plan.fingerprint, appOptions, f.io, f.checks), /Live state changed/);
  assert.equal(writes(f).length, 0);
});

test("apply issues CREATE only, waits for INSYNC and reports public verification separately", async () => {
  const f = fixture(), plan = await preview(options, f.io, f.checks);
  let polls = 0; f.responses["get-change"] = () => ({ ChangeInfo: { Id: "/change/C123", Status: ++polls === 1 ? "PENDING" : "INSYNC" } });
  f.checks.public = async () => ({ status: "UNVERIFIED" });
  const result = await apply(plan, plan.fingerprint, options, f.io, f.checks);
  assert.equal(result.submission, "INSYNC"); assert.equal(result.publicVerification.status, "UNVERIFIED"); assert.equal(polls, 2);
  assert.equal(writes(f).length, 1); assert.deepEqual(writes(f)[0]!.input.ChangeBatch.Changes, plan.state.changes);
});

test("Route53 wait is bounded and does not resubmit", async () => {
  const f = fixture(), plan = await preview(options, f.io, f.checks);
  f.responses["get-change"].ChangeInfo.Status = "PENDING";
  const result = await apply(plan, plan.fingerprint, options, f.io, f.checks);
  assert.equal(result.submission, "PENDING"); assert.equal(writes(f).length, 1); assert.equal(f.calls.filter(c => c.operation === "get-change").length, 60);
});

test("API errors are sanitized and failed writes are not retried", async () => {
  const f = fixture(); f.responses["describe-certificate"] = new Error("fixture-secret");
  await assert.rejects(preview(options, f.io, f.checks), e => e instanceof Error && e.message.includes("acm/describe-certificate failed") && !e.message.includes("fixture-secret"));
  const good = fixture(), plan = await preview(options, good.io, good.checks); good.responses["change-resource-record-sets"] = new Error("fixture-secret");
  await assert.rejects(apply(plan, plan.fingerprint, options, good.io, good.checks), /uncertain outcome/); assert.equal(writes(good).length, 1);
});

test("Route53 pagination includes name/type/identifier and sees late conflicts", async () => {
  const f = fixture(); let calls = 0;
  f.responses["list-resource-record-sets"] = (input: any) => ++calls === 1 ? { ResourceRecordSets: [], IsTruncated: true, NextRecordName: validationName, NextRecordType: "CNAME", NextRecordIdentifier: "weighted" } : (assert.deepEqual(input, { HostedZoneId: CONTRACT.zone, StartRecordName: validationName, StartRecordType: "CNAME", StartRecordIdentifier: "weighted" }), { IsTruncated: false, ResourceRecordSets: [{ Name: validationName, Type: "CNAME", TTL: 300, SetIdentifier: "weighted", Weight: 1, ResourceRecords: [{ Value: validationValue }] }] });
  await assert.rejects(preview(options, f.io, f.checks), /Conflicting/); assert.equal(calls, 2);
});

test("repeating or malformed pagination fails closed", async () => {
  for (const cursor of [{ NextRecordName: validationName, NextRecordType: "CNAME" }, {}]) { const f = fixture(); f.responses["list-resource-record-sets"] = { IsTruncated: true, ResourceRecordSets: [], ...cursor }; await assert.rejects(preview(options, f.io, f.checks), /pagination/); }
});

test("profile/CLI parser forbids implicit identity, arbitrary targets and duplicate options", () => {
  for (const profile of ["", "default", "ROOT", "--evil", "name;command"]) assert.throws(() => validateOptions({ ...options, profile }));
  assert.throws(() => validateOptions({ ...options, certificateArn: certArn.replace(CONTRACT.region, "us-east-1") }));
  const args = ["--profile", options.profile, "--phase", "validation", "--certificate-arn", certArn, "--plan", ".data/dns.json"];
  assert.equal(parseArgs(args).apply, false);
  for (const extra of [["--target", "other"], ["--profile", "again"], ["--apply"], ["--confirm", "abc"]]) assert.throws(() => parseArgs([...args, ...extra]));
});

test("CLI transport strips inherited credentials/endpoints, fixes profile/region and bounds subprocess", async () => {
  const env = cliEnvironment({ PATH: "system-path", AWS_ACCESS_KEY_ID: "fixture-secret", AWS_SECRET_ACCESS_KEY: "fixture-secret", AWS_PROFILE: "default", AWS_ENDPOINT_URL: "https://attacker.example", NODE_OPTIONS: "unsafe" });
  assert(!JSON.stringify(env).includes("fixture-secret")); assert.equal(env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS, "true");
  let inspected = false;
  const execute = ((command: string, args: string[], settings: any) => { inspected = true; assert.equal(command, "aws"); assert.equal(args[args.indexOf("--profile") + 1], options.profile); assert.equal(args[args.indexOf("--region") + 1], CONTRACT.region); assert(args.includes("--no-paginate")); assert.equal(settings.timeout, 30_000); assert.equal(settings.shell, false); return { status: 0, stdout: '{"Account":"543777713748"}' }; }) as unknown as typeof spawnSync;
  assert.equal((await cliTransport(options.profile, execute).call("sts", "get-caller-identity")).Account, CONTRACT.account); assert(inspected);
});

test("public DNS/TLS checks are distinct from submission and use mocked resolver only", async () => {
  const f = fixture(), plan = await preview(appOptions, f.io, f.checks);
  let fail = false;
  const resolver = { resolveNs: async () => ["ns-1.awsdns.com", "ns-2.awsdns.net"], resolve4: async () => { if (fail) throw new Error("fixture-secret"); return ["192.0.2.1"]; }, resolveCname: async () => [validationValue] } as unknown as Resolver;
  const checks = networkChecks(resolver, async () => true);
  assert.equal((await checks.public(plan.state)).status, "VERIFIED"); fail = true;
  assert.equal((await checks.public(plan.state)).status, "UNVERIFIED");
  assert.equal((await networkChecks(resolver, async () => false).public(plan.state)).status, "UNVERIFIED");
  const validation = await preview(options, f.io, f.checks); assert.equal((await checks.public(validation.state)).certificateIssuance, "NOT_CHECKED");
  assert.equal(await probeHttps("attacker.example"), false);
});

test("HTTPS probes enforce app SNI/Host, verified TLS, correct JSON and hosted readiness", async () => {
  for (const failure of ["none", "redirect", "invalid-json", "local", "oversize"]) {
    const paths: string[] = [];
    const open = ((settings: any, callback: any) => {
      paths.push(settings.path);
      assert.equal(settings.hostname, "admitflow-prod-alb-123456.ap-southeast-1.elb.amazonaws.com");
      assert.equal(settings.servername, "admitflow.incfrog.ai"); assert.equal(settings.headers.Host, settings.servername); assert.equal(settings.rejectUnauthorized, true); assert.equal(settings.agent, false);
      const req = new EventEmitter() as any;
      req.destroy = () => {};
      req.end = () => queueMicrotask(() => {
        const response = Object.assign(new PassThrough(), { statusCode: failure === "redirect" ? 302 : 200 });
        callback(response);
        response.end(failure === "invalid-json" ? "not-json" : failure === "oversize" ? "x".repeat(5000) : JSON.stringify(settings.path === "/api/health" ? { status: "ok" } : { status: "ready", mode: failure === "local" ? "local" : "hosted" }));
      });
      return req;
    }) as unknown as typeof request;
    assert.equal(await probeHttps("admitflow-prod-alb-123456.ap-southeast-1.elb.amazonaws.com", open), failure === "none");
    if (failure === "none") assert.deepEqual(paths, ["/api/health", "/api/ready"]);
  }
});

test("listener pagination follows markers and rejects repeated cursors", async () => {
  const f = fixture(), listener = f.responses["describe-listeners"].Listeners[0];
  let count = 0;
  f.responses["describe-listeners"] = (input: any) => ++count === 1 ? { Listeners: [], NextMarker: "second-page" } : (assert.equal(input.Marker, "second-page"), { Listeners: [listener] });
  await preview(appOptions, f.io, f.checks); assert.equal(count, 2);
  f.responses["describe-listeners"] = { Listeners: [], NextMarker: "repeat" };
  await assert.rejects(preview(appOptions, f.io, f.checks), /pagination/);
});

test("approval expiring during live inventory cannot submit", async () => {
  const f = fixture(), plan = await preview(options, f.io, f.checks);
  let calls = 0; f.io.now = () => ++calls === 1 ? now : now + 900_001;
  await assert.rejects(apply(plan, plan.fingerprint, options, f.io, f.checks), /expired during/); assert.equal(writes(f).length, 0);
});
