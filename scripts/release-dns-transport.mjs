import { spawnSync } from "node:child_process";
import { Resolver } from "node:dns/promises";
import { request } from "node:https";
import { CONTRACT } from "./release-dns.mjs";

export function cliEnvironment(parent) {
  const env = {};
  for (const [key, value] of Object.entries(parent)) if (value !== undefined && /^(path|systemroot|windir|comspec|pathext|temp|tmp|home|userprofile|appdata|localappdata|programfiles|programfiles\(x86\)|programdata|systemdrive)$/i.test(key)) env[key] = value;
  return { ...env, AWS_EC2_METADATA_DISABLED: "true", AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: "true", AWS_MAX_ATTEMPTS: "1", AWS_PAGER: "", AWS_CLI_AUTO_PROMPT: "off" };
}

/** AWS CLI v2 uses one explicitly chosen local profile; credentials are never read by this script or printed. */
export function cliTransport(profile, execute = spawnSync) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(profile ?? "") || /^(default|root)$/i.test(profile)) throw new Error("Named non-root profile required.");
  return {
    now: () => Date.now(),
    sleep: milliseconds => new Promise(done => setTimeout(done, milliseconds)),
    call: async (service, operation, input = {}) => {
      const result = execute("aws", [service, operation, "--cli-input-json", JSON.stringify(input), "--profile", profile, "--region", CONTRACT.region, "--output", "json", "--no-paginate", "--no-cli-pager", "--no-cli-auto-prompt", "--cli-connect-timeout", "5", "--cli-read-timeout", "20"], { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, shell: false, env: cliEnvironment(process.env), stdio: ["ignore", "pipe", "pipe"] });
      if (result.error || result.status !== 0) throw new Error("AWS CLI operation failed.");
      try { return JSON.parse(result.stdout); } catch { throw new Error("AWS CLI returned invalid JSON."); }
    },
  };
}

const normalize = name => `${name.toLowerCase().replace(/\.$/, "")}.`;
const sameNames = (left, right) => JSON.stringify(left.map(normalize).sort()) === JSON.stringify(right.map(normalize).sort());

// Connect to the returned ALB endpoint before publishing DNS, while verifying the
// certificate against the application SNI/Host. Redirects and bodies are not logged.
export async function probeHttps(hostname, open = request) {
  if (hostname !== "admitflow.incfrog.ai" && !/^admitflow-prod-alb-[0-9]+\.ap-southeast-1\.elb\.amazonaws\.com$/.test(hostname)) return false;
  for (const path of ["/api/health", "/api/ready"]) {
    const ok = await new Promise(resolve => {
      let settled = false;
      const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
      const req = open({ hostname, port: 443, path, method: "GET", servername: "admitflow.incfrog.ai", headers: { Host: "admitflow.incfrog.ai", "User-Agent": "AdmitFlow-DNS-release-check" }, rejectUnauthorized: true, agent: false }, response => {
        if (response.statusCode !== 200) { response.destroy(); finish(false); return; }
        let body = "";
        response.setEncoding("utf8");
        response.on("data", chunk => { body += chunk; if (body.length > 4096) { response.destroy(); finish(false); } });
        response.on("error", () => finish(false));
        response.on("end", () => {
          try { const value = JSON.parse(body); finish(path === "/api/health" ? value.status === "ok" : value.status === "ready" && value.mode === "hosted"); }
          catch { finish(false); }
        });
      });
      const timer = setTimeout(() => { req.destroy(); finish(false); }, 10_000);
      req.on("error", () => finish(false));
      req.end();
    });
    if (!ok) return false;
  }
  return true;
}

/** Optional dependencies exist for offline tests; no resolver query is made on construction. */
export function networkChecks(resolver = new Resolver({ timeout: 3000, tries: 2 }), https = probeHttps) {
  return {
    delegation: async (name, nameservers) => { try { return sameNames(await resolver.resolveNs(name), nameservers); } catch { return false; } },
    https,
    public: async state => {
      try {
        if (!sameNames(await resolver.resolveNs(CONTRACT.zoneName), state.nameservers)) return { status: "UNVERIFIED", dns: "DELEGATION_MISMATCH", tls: "NOT_CHECKED" };
        if (state.options.phase === "validation") {
          const matches = sameNames(await resolver.resolveCname(state.targets.validationName), [state.targets.validationValue]);
          return { status: matches ? "VERIFIED" : "UNVERIFIED", dns: matches ? "CNAME_MATCH" : "CNAME_MISMATCH", tls: "NOT_APPLICABLE", certificateIssuance: "NOT_CHECKED" };
        }
        for (const record of state.desired) {
          const method = record.Type === "AAAA" ? "resolve6" : "resolve4";
          const actual = await resolver[method](CONTRACT.app), target = await resolver[method](record.AliasTarget.DNSName);
          // ALB answers can rotate; mismatches fail conservatively, never prove a different target is safe.
          if (!actual.length || !actual.every(address => target.includes(address))) return { status: "UNVERIFIED", dns: "ADDRESS_MISMATCH_OR_PROPAGATING", tls: "NOT_CHECKED" };
        }
        const tls = await https("admitflow.incfrog.ai");
        return { status: tls ? "VERIFIED" : "UNVERIFIED", dns: "RESOLVER_ADDRESSES_MATCH", tls: tls ? "HEALTH_AND_READINESS_OK" : "FAILED" };
      } catch { return { status: "UNVERIFIED", dns: "LOOKUP_FAILED_OR_PROPAGATING", tls: "NOT_CHECKED" }; }
    },
  };
}
