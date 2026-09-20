import { createHash } from "node:crypto";
import { readFile, writeFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cliTransport, networkChecks } from "./release-dns-transport.mjs";

export const CONTRACT = Object.freeze({ account: "543777713748", region: "ap-southeast-1", zone: "Z07524403BCACLCZ72JOD", zoneName: "incfrog.ai.", app: "admitflow.incfrog.ai.", alb: "admitflow-prod-alb", targetGroup: "admitflow-prod-web", cluster: "admitflow-prod" });
const MAX_AGE = 15 * 60_000;
export class DnsError extends Error {}
function requireThat(ok, message) { if (!ok) throw new DnsError(message); }
const fqdn = value => typeof value === "string" ? `${value.toLowerCase().replace(/\.$/, "")}.` : "";
const zoneId = value => typeof value === "string" ? value.replace(/^\/hostedzone\//, "") : "";
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
export const fingerprint = value => createHash("sha256").update(canonical(value)).digest("hex");
const same = (a, b) => canonical(a) === canonical(b);
const arnPrefix = service => `arn:aws:${service}:${CONTRACT.region}:${CONTRACT.account}:`;

export function validateOptions(options) {
  requireThat(options && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(options.profile ?? "") && !/^(default|root)$/i.test(options.profile), "An explicit non-default, non-root AWS CLI profile is required.");
  requireThat(["validation", "application"].includes(options.phase), "Choose validation or application phase.");
  requireThat(new RegExp(`^${arnPrefix("acm")}certificate/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`).test(options.certificateArn ?? ""), "Certificate ARN must belong to the expected account and region.");
  if (options.phase === "application") requireThat(/^[a-f0-9]{64}$/.test(options.acceptRelease ?? ""), "Application alias requires --accept-release SHA256 of the reviewed release-acceptance evidence.");
  else requireThat(!options.acceptRelease, "Release acceptance is only valid for the application phase.");
}

/** @param {any} io @param {string} service @param {string} operation @param {any} input */
async function call(io, service, operation, input = {}) {
  try { return await io.call(service, operation, input); }
  catch { throw new DnsError(`AWS ${service}/${operation} failed; no raw provider diagnostics are displayed. A write failure may have an uncertain outcome; inspect before retrying.`); }
}

async function inventory(io) {
  const records = [], seen = new Set();
  let cursor = {};
  for (let page = 0; page < 100; page++) {
    const response = await call(io, "route53", "list-resource-record-sets", { HostedZoneId: CONTRACT.zone, ...cursor });
    requireThat(Array.isArray(response.ResourceRecordSets) && typeof response.IsTruncated === "boolean", "Invalid DNS inventory response.");
    records.push(...response.ResourceRecordSets);
    if (!response.IsTruncated) return records;
    requireThat(typeof response.NextRecordName === "string" && typeof response.NextRecordType === "string", "Incomplete DNS pagination cursor.");
    cursor = { StartRecordName: response.NextRecordName, StartRecordType: response.NextRecordType, ...(response.NextRecordIdentifier ? { StartRecordIdentifier: response.NextRecordIdentifier } : {}) };
    const key = canonical(cursor);
    requireThat(!seen.has(key), "Repeated DNS pagination cursor.");
    seen.add(key);
  }
  throw new DnsError("DNS inventory page limit exceeded; no writes allowed.");
}

function normalizeRecord(record) {
  const result = { ...record, Name: fqdn(record.Name) };
  if (record.AliasTarget) result.AliasTarget = { ...record.AliasTarget, DNSName: fqdn(record.AliasTarget.DNSName), HostedZoneId: zoneId(record.AliasTarget.HostedZoneId) };
  if (record.ResourceRecords) result.ResourceRecords = record.ResourceRecords.map(item => ({ ...item, Value: record.Type === "CNAME" ? fqdn(item.Value) : item.Value })).sort((a, b) => canonical(a).localeCompare(canonical(b)));
  return result;
}

function changesFor(records, desired) {
  for (const wanted of desired) {
    for (const record of records) {
      const name = fqdn(record.Name);
      requireThat(name, "Malformed DNS record name.");
      if (name !== CONTRACT.zoneName && ["NS", "DNAME"].includes(record.Type) && (wanted.Name === name || wanted.Name.endsWith(`.${name}`))) throw new DnsError("Relevant DNS delegation or DNAME exists; reconcile separately.");
      // A CNAME at the app name also obstructs its validation child.
      if (record.Type === "CNAME" && wanted.Name !== name && wanted.Name.endsWith(`.${name}`)) throw new DnsError("Ancestor CNAME obstructs the desired name.");
      if (name === wanted.Name) {
        const expected = desired.find(item => item.Name === name && item.Type === record.Type);
        requireThat(expected && same(normalizeRecord(record), expected), "Conflicting record exists at an application-owned name; no overwrite allowed.");
      }
    }
  }
  return desired.filter(wanted => !records.some(record => same(normalizeRecord(record), wanted))).map(ResourceRecordSet => ({ Action: "CREATE", ResourceRecordSet }));
}

async function readState(options, io, checks) {
  validateOptions(options);
  const identity = await call(io, "sts", "get-caller-identity");
  requireThat(identity.Account === CONTRACT.account && typeof identity.Arn === "string" && new RegExp(`^arn:aws:sts::${CONTRACT.account}:assumed-role/admitflow-prod-bootstrap/[A-Za-z0-9+=,.@_-]+$`).test(identity.Arn), "Expected account and non-root admitflow-prod-bootstrap assumed-role identity required.");
  const zone = await call(io, "route53", "get-hosted-zone", { Id: CONTRACT.zone });
  requireThat(zoneId(zone.HostedZone?.Id) === CONTRACT.zone && fqdn(zone.HostedZone?.Name) === CONTRACT.zoneName && zone.HostedZone?.Config?.PrivateZone === false, "Exact public hosted zone identity/name required.");
  const nameservers = zone.DelegationSet?.NameServers?.map(fqdn).sort();
  requireThat(Array.isArray(nameservers) && nameservers.length >= 2 && nameservers.every(name => /^[a-z0-9.-]+\.$/.test(name)), "Hosted zone delegation metadata required.");
  requireThat(await checks.delegation(CONTRACT.zoneName, nameservers), "Public zone NS delegation does not match the hosted zone.");
  const response = await call(io, "acm", "describe-certificate", { CertificateArn: options.certificateArn });
  const cert = response.Certificate;
  requireThat(cert?.CertificateArn === options.certificateArn && fqdn(cert.DomainName) === CONTRACT.app && cert.Type === "AMAZON_ISSUED" && Array.isArray(cert.SubjectAlternativeNames) && cert.SubjectAlternativeNames.length === 1 && fqdn(cert.SubjectAlternativeNames[0]) === CONTRACT.app && ["PENDING_VALIDATION", "ISSUED"].includes(cert.Status), "ACM certificate must be an active Amazon-issued exact-domain certificate.");
  requireThat(cert.DomainValidationOptions?.length === 1, "Exactly one ACM domain validation option is required.");
  const validation = cert.DomainValidationOptions[0], record = validation.ResourceRecord;
  requireThat(fqdn(validation.DomainName) === CONTRACT.app && validation.ValidationMethod === "DNS" && record?.Type === "CNAME", "Actual ACM DNS validation CNAME is required.");
  const validationName = fqdn(record.Name), validationValue = fqdn(record.Value);
  requireThat(/^_[a-f0-9]{32}\.admitflow\.incfrog\.ai\.$/.test(validationName) && /^_[a-z0-9-]+(?:\.[a-z0-9-]+)*\.acm-validations\.aws\.$/.test(validationValue), "ACM validation name/target is outside the exact allowed scope.");
  const desired = [], targets = { certificateArn: cert.CertificateArn, validationName, validationValue };
  if (options.phase === "validation") {
    desired.push({ Name: validationName, Type: "CNAME", TTL: 300, ResourceRecords: [{ Value: validationValue }] });
  } else {
    requireThat(cert.Status === "ISSUED" && Date.parse(cert.NotAfter) > io.now() + 86_400_000, "Application alias requires an issued, unexpired certificate.");
    const balancers = await call(io, "elbv2", "describe-load-balancers", { Names: [CONTRACT.alb] });
    requireThat(!balancers.NextMarker && balancers.LoadBalancers?.length === 1, "Exactly one named ALB is required.");
    const alb = balancers.LoadBalancers[0];
    requireThat(new RegExp(`^${arnPrefix("elasticloadbalancing")}loadbalancer/app/${CONTRACT.alb}/[a-f0-9]+$`).test(alb.LoadBalancerArn ?? "") && alb.LoadBalancerName === CONTRACT.alb && alb.Type === "application" && alb.Scheme === "internet-facing" && alb.State?.Code === "active", "Expected active internet-facing application load balancer required.");
    requireThat(new RegExp(`^${CONTRACT.alb}-[0-9]+\\.${CONTRACT.region}\\.elb\\.amazonaws\\.com\\.$`).test(fqdn(alb.DNSName)) && /^Z[A-Z0-9]+$/.test(alb.CanonicalHostedZoneId ?? "") && ["ipv4", "dualstack"].includes(alb.IpAddressType), "ALB DNS, canonical hosted-zone ID, or supported IP mode is invalid.");
    const listeners = [], markers = new Set();
    let marker;
    for (let page = 0; page < 20; page++) {
      const response = await call(io, "elbv2", "describe-listeners", { LoadBalancerArn: alb.LoadBalancerArn, ...(marker ? { Marker: marker } : {}) });
      requireThat(Array.isArray(response.Listeners), "Invalid ALB listener response.");
      listeners.push(...response.Listeners);
      marker = response.NextMarker;
      if (!marker) break;
      requireThat(typeof marker === "string" && !markers.has(marker) && page < 19, "Invalid or excessive ALB listener pagination.");
      markers.add(marker);
    }
    const httpsListeners = listeners.filter(listener => listener.Port === 443 && listener.Protocol === "HTTPS");
    requireThat(httpsListeners.length === 1 && httpsListeners[0].LoadBalancerArn === alb.LoadBalancerArn && httpsListeners[0].Certificates?.some(cert => cert.CertificateArn === options.certificateArn), "HTTPS listener must use the reviewed ACM certificate on the actual ALB.");
    const groups = await call(io, "elbv2", "describe-target-groups", { Names: [CONTRACT.targetGroup] });
    requireThat(!groups.NextMarker && groups.TargetGroups?.length === 1, "Exactly one web target group is required.");
    const group = groups.TargetGroups[0];
    requireThat(new RegExp(`^${arnPrefix("elasticloadbalancing")}targetgroup/${CONTRACT.targetGroup}/[a-f0-9]+$`).test(group.TargetGroupArn ?? "") && group.TargetGroupName === CONTRACT.targetGroup && group.LoadBalancerArns?.length === 1 && group.LoadBalancerArns[0] === alb.LoadBalancerArn && group.HealthCheckPath === "/api/health", "Web target group must belong to the expected ALB.");
    const health = await call(io, "elbv2", "describe-target-health", { TargetGroupArn: group.TargetGroupArn });
    requireThat(health.TargetHealthDescriptions?.length > 0 && health.TargetHealthDescriptions.every(item => item.TargetHealth?.State === "healthy"), "All registered web targets must be healthy.");
    const services = await call(io, "ecs", "describe-services", { cluster: CONTRACT.cluster, services: ["admitflow-prod-web", "admitflow-prod-worker"] });
    requireThat(Array.isArray(services.failures) && services.failures.length === 0 && services.services?.length === 2, "Both application services must be present.");
    for (const name of ["admitflow-prod-web", "admitflow-prod-worker"]) {
      const service = services.services.find(item => item.serviceName === name);
      requireThat(new RegExp(`^${arnPrefix("ecs")}task-definition/${name}:[1-9][0-9]*$`).test(service?.taskDefinition ?? ""), "Expected application task definition family required.");
      if (name === "admitflow-prod-web") requireThat(Array.isArray(service.loadBalancers) && service.loadBalancers.some(binding => binding?.targetGroupArn === group.TargetGroupArn && binding.containerName === "web" && binding.containerPort === 3000), "Web service must bind the inspected target group to container web on port 3000.");
      requireThat(service?.clusterArn === `${arnPrefix("ecs")}cluster/${CONTRACT.cluster}` && service.serviceArn === `${arnPrefix("ecs")}service/${CONTRACT.cluster}/${name}` && service.status === "ACTIVE" && service.desiredCount >= 1 && service.runningCount === service.desiredCount && service.pendingCount === 0 && service.deployments?.length === 1 && service.deployments[0].status === "PRIMARY" && service.deployments[0].rolloutState === "COMPLETED", "Web and worker must have completed stable nonzero deployments.");
    }
    requireThat(await checks.https(alb.DNSName), "Direct ALB TLS/SNI health and readiness checks failed.");
    Object.assign(targets, { albArn: alb.LoadBalancerArn, dnsName: fqdn(alb.DNSName), canonicalZone: alb.CanonicalHostedZoneId, ipAddressType: alb.IpAddressType, targetGroupArn: group.TargetGroupArn, services: services.services.map(service => ({ name: service.serviceName, taskDefinition: service.taskDefinition, desiredCount: service.desiredCount })).sort((a, b) => a.name.localeCompare(b.name)) });
    // Route53's documented dualstack prefix derives only from the verified AWS-returned endpoint.
    const aliasDnsName = fqdn(`${alb.IpAddressType === "dualstack" ? "dualstack." : ""}${alb.DNSName}`);
    for (const Type of alb.IpAddressType === "dualstack" ? ["A", "AAAA"] : ["A"]) desired.push({ Name: CONTRACT.app, Type, AliasTarget: { DNSName: aliasDnsName, HostedZoneId: alb.CanonicalHostedZoneId, EvaluateTargetHealth: true } });
  }
  const records = await inventory(io);
  const changes = changesFor(records, desired);
  return { version: 1, contract: CONTRACT, options, identity: identity.Arn, nameservers, targets, desired, changes, inventoryHash: fingerprint(records.map(normalizeRecord).sort((a, b) => canonical(a).localeCompare(canonical(b)))) };
}

/** Runtime I/O must be supplied explicitly; importing this module never contacts AWS. */
export async function preview(options, io, checks) {
  const state = await readState(options, io, checks);
  const plan = { createdAt: io.now(), state };
  return { ...plan, fingerprint: fingerprint(plan) };
}

export async function apply(reviewed, confirmation, options, io, checks) {
  requireThat(reviewed?.state && /^[a-f0-9]{64}$/.test(confirmation ?? "") && confirmation === reviewed.fingerprint && fingerprint({ createdAt: reviewed.createdAt, state: reviewed.state }) === confirmation, "Reviewed plan fingerprint/confirmation mismatch.");
  const age = io.now() - reviewed.createdAt;
  requireThat(Number.isFinite(age) && age >= 0 && age <= MAX_AGE, "Reviewed plan expired or has an invalid timestamp; preview again.");
  requireThat(same(options, reviewed.state.options), "Apply options differ from the reviewed plan.");
  const fresh = await readState(options, io, checks);
  requireThat(same(fresh, reviewed.state), "Live state changed since review; generate and review a fresh plan.");
  requireThat(io.now() - reviewed.createdAt <= MAX_AGE, "Reviewed plan expired during revalidation; preview again.");
  if (!fresh.changes.length) return { submission: "NOOP", publicVerification: await checks.public(fresh) };
  const result = await call(io, "route53", "change-resource-record-sets", { HostedZoneId: CONTRACT.zone, ChangeBatch: { Comment: `AdmitFlow reviewed DNS ${confirmation}`, Changes: fresh.changes } });
  const id = result.ChangeInfo?.Id;
  requireThat(typeof id === "string" && /^\/change\/[A-Z0-9]+$/.test(id), "Submission outcome uncertain: no valid change ID returned; inspect Route53 before retrying.");
  for (let attempt = 0; attempt < 60; attempt++) {
    const change = await call(io, "route53", "get-change", { Id: id });
    requireThat(change.ChangeInfo?.Id === id && ["PENDING", "INSYNC"].includes(change.ChangeInfo.Status), "Invalid Route53 change status; inspect the submitted change.");
    if (change.ChangeInfo.Status === "INSYNC") return { submission: "INSYNC", changeId: id, publicVerification: await checks.public(fresh) };
    await io.sleep(5000);
  }
  return { submission: "PENDING", changeId: id, publicVerification: { status: "NOT_CHECKED", reason: "Route53 wait limit reached; do not blindly resubmit." } };
}

export function parseArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    requireThat(["--profile", "--phase", "--certificate-arn", "--accept-release", "--plan", "--confirm", "--apply"].includes(key) && !(key in values), "Unknown or duplicate DNS option; use --help.");
    if (key === "--apply") values[key] = true;
    else { const value = args[++index]; requireThat(value && !value.startsWith("--"), "Missing DNS option value."); values[key] = value; }
  }
  const options = { profile: values["--profile"], phase: values["--phase"], certificateArn: values["--certificate-arn"], ...(values["--accept-release"] ? { acceptRelease: values["--accept-release"] } : {}) };
  validateOptions(options);
  requireThat(typeof values["--plan"] === "string", "--plan path is required (preview creates a new file, apply reads it).");
  requireThat(values["--apply"] ? typeof values["--confirm"] === "string" : !values["--confirm"], "--confirm is required only with --apply.");
  return { options, filename: values["--plan"], apply: values["--apply"] === true, confirmation: values["--confirm"] };
}

async function main() {
  if (process.argv.length === 3 && process.argv[2] === "--help") {
    console.log("DNS preview (read-only AWS calls): --profile NAME --phase validation|application --certificate-arn ARN --plan NEW_FILE [--accept-release SHA256]. Apply additionally requires --apply --confirm PLAN_SHA256 and the same options. Never use the root/default profile. Certificate requests are separate. Plans expire after 15 minutes; serialize DNS operators."); return;
  }
  const args = parseArgs(process.argv.slice(2)), io = cliTransport(args.options.profile), checks = networkChecks();
  if (!args.apply) {
    const plan = await preview(args.options, io, checks);
    await writeFile(args.filename, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify(plan, null, 2));
  } else {
    requireThat((await stat(args.filename)).size <= 100_000, "Reviewed plan file is too large.");
    const reviewed = JSON.parse(await readFile(args.filename, "utf8"));
    const result = await apply(reviewed, args.confirmation, args.options, io, checks);
    console.log(JSON.stringify(result, null, 2));
    if (result.submission === "PENDING" || result.publicVerification.status !== "VERIFIED") process.exitCode = 2;
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main().catch(error => { console.error(error instanceof DnsError ? error.message : "DNS operation failed. Inspect nonsecret inputs and submitted change status; raw errors are suppressed."); process.exitCode = 1; });
