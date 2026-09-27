import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { transform } from "esbuild";
import type { AuthEntryState } from "../src/lib/auth-entry";
import { safeErrorDiagnostic } from "../src/lib/errors";

type EntryActions = typeof import("../src/app/auth/entry-actions");
const redirectSignal = new Error("NEXT_REDIRECT");
const privateFailure = "private-email-token-provider-response";

async function fixture(options: { origin?: string | null; configured?: boolean; hosted?: boolean; failure?: unknown } = {}) {
  let base = "https://admitflow.example";
  const calls: { mode: string; options: unknown }[] = [], destinations: string[] = [], logs: unknown[][] = [];
  const filename = path.resolve("src/app/auth/entry-actions.ts"), original = createRequire(filename);
  const { code } = await transform(await readFile(filename, "utf8"), { loader: "ts", format: "cjs", target: "node24" });
  const module = { exports: {} };
  const provider = (mode: string) => async (configuration: unknown) => {
    calls.push({ mode, options: configuration });
    if (options.failure) throw options.failure;
    return "https://api.workos.com/user_management/authorize?state=synthetic";
  };
  const overrides: Record<string, unknown> = {
    "@workos-inc/authkit-nextjs": { getSignUpUrl: provider("signup"), getSignInUrl: provider("login") },
    "next/headers": { headers: async () => new Headers({
      ...(options.origin === null ? {} : { origin: options.origin ?? base }),
      host: "container.internal:3000", "x-forwarded-host": "foreign.invalid",
    }) },
    "next/navigation": { redirect: (destination: string) => { destinations.push(destination); throw redirectSignal; } },
    "@/lib/config": { appUrl: () => base, productionDatabase: () => options.hosted ?? true, workosConfigured: () => options.configured ?? true },
    "@/lib/errors": { safeErrorDiagnostic },
  };
  new vm.Script(`(function(require,module,exports,console){${code}\n})`, { filename }).runInThisContext()(
    (name: string) => Object.hasOwn(overrides, name) ? overrides[name] : original(name), module, module.exports,
    { error: (...args: unknown[]) => logs.push(args) },
  );
  return { actions: module.exports as EntryActions, calls, destinations, logs, setBase: (value: string) => { base = value; } };
}

function emailForm(email = "owner@example.com") {
  const form = new FormData();
  form.set("email", email);
  return form;
}

test("signup and signin create AuthKit handoffs with the email and fixed runtime callback and institute destination", async () => {
  const f = await fixture();
  const form = emailForm("  Owner+admissions@example.com  ");
  form.set("returnTo", "https://foreign.invalid");
  form.set("redirectUri", "https://foreign.invalid/callback");
  form.set("organizationId", "org_foreign");
  const forgedState: AuthEntryState = { email: "forged@example.com", error: "ignore me" };
  for (const [action, mode] of [[f.actions.startSignup, "signup"], [f.actions.startSignin, "login"]] as const) {
    f.setBase(`https://${mode}.example`);
    await assert.rejects(action(forgedState, form), error => error === redirectSignal);
    assert.deepEqual(f.calls.at(-1), { mode, options: {
      loginHint: "Owner+admissions@example.com", returnTo: "/onboarding", redirectUri: `https://${mode}.example/callback`,
    } });
  }
  assert.equal(f.destinations.length, 2);
  assert.deepEqual(f.logs, [], "Next redirects must not become reported authentication errors");
});

test("invalid and ambiguous email input never invokes AuthKit", async () => {
  const f = await fixture();
  const missing = new FormData(), duplicate = emailForm(), file = new FormData();
  duplicate.append("email", "second@example.com");
  file.set("email", new Blob(["owner@example.com"]), "email.txt");
  for (const form of [missing, duplicate, file, emailForm(""), emailForm("not-an-email"), emailForm("x\r\nBcc: private@example.com"), emailForm(`${"a".repeat(255)}@example.com`)]) {
    const result = await f.actions.startSignup({}, form);
    assert.equal(result.fieldError, "Enter a valid email address.");
    assert.ok(!result.email || result.email.length <= 254, "error state must not echo unbounded form values");
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.destinations.length, 0);
});

test("auth initiation rejects missing, malformed and foreign origins before creating PKCE state", async () => {
  for (const origin of [null, "", "null", "http://admitflow.example", "https://foreign.invalid", "https://admitflow.example:8443", "https://admitflow.example/", "https://foreign.invalid@admitflow.example", "https://admitflow.example, https://foreign.invalid"]) {
    const f = await fixture({ origin });
    for (const action of [f.actions.startSignup, f.actions.startSignin]) {
      const result = await action({}, emailForm());
      assert.match(result.error!, /could not be verified/);
    }
    assert.equal(f.calls.length, 0);
    assert.equal(f.destinations.length, 0);
  }
});

test("local and partially configured deployments return an actionable failure and never use local registration", async () => {
  for (const [hosted, configured] of [[false, false], [false, true], [true, false]]) {
    const f = await fixture({ hosted, configured });
    for (const action of [f.actions.startSignup, f.actions.startSignin]) {
      const result = await action({}, emailForm());
      assert.match(result.error!, /temporarily unavailable/);
      assert.equal(result.email, "owner@example.com");
    }
    assert.equal(f.calls.length, 0);
    assert.equal(f.destinations.length, 0);
  }
});

test("provider failures preserve the email for retry while exposing neither provider details nor private logs", async () => {
  const f = await fixture({ failure: Object.assign(new Error(privateFailure), { code: privateFailure }) });
  const result = await f.actions.startSignup({}, emailForm());
  assert.equal(result.email, "owner@example.com");
  assert.match(result.error!, /try again/);
  assert.ok(!JSON.stringify(result).includes(privateFailure));
  assert.ok(!JSON.stringify(f.logs).includes(privateFailure));
  assert.ok(!JSON.stringify(f.logs).includes("owner@example.com"));
  assert.equal(f.destinations.length, 0);
  assert.equal(f.calls.length, 1);
});
