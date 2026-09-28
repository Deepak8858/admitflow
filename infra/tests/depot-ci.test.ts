import test from "node:test";
import assert from "node:assert/strict";
import { depotCheckApp, depotOrganization, requiredChecks, requireMainSuite, selectDepotChecks } from "../require-depot-ci.mjs";

const sha = "a".repeat(40), repository = "Deepak8858/admitflow";
function fixtures() {
  return requiredChecks.map((name, index) => ({
    id: index + 1, name, app: { ...depotCheckApp }, check_suite: { id: 20 },
    head_sha: sha, status: "completed", conclusion: "success",
    details_url: `https://depot.dev/orgs/${depotOrganization}/workflows/abc123?job=job${index}&repo=Deepak8858%2Fadmitflow`,
  }));
}
function suite() {
  return { id: 20, app: { ...depotCheckApp }, head_sha: sha, head_branch: "main", status: "completed", conclusion: "success" };
}

test("release CI accepts a complete exact-commit Depot workflow and main suite", () => {
  const checks = selectDepotChecks(fixtures().reverse(), sha, repository);
  assert.deepEqual(checks.map(check => check.name), requiredChecks);
  assert.doesNotThrow(() => requireMainSuite(suite(), checks, sha));
});

test("same-named checks from a different app cannot authorize release", () => {
  for (const app of [{ id: 1, slug: depotCheckApp.slug }, { id: depotCheckApp.id, slug: "github-actions" }]) {
    const checks = fixtures();
    checks[0].app = app;
    assert.throws(() => selectDepotChecks(checks, sha, repository), /Missing successful/);
  }
});

test("partial, stale, running, failed, neutral, skipped and cancelled checks block release", () => {
  assert.throws(() => selectDepotChecks(fixtures().slice(1), sha, repository));
  for (const patch of [
    { head_sha: "b".repeat(40) }, { status: "in_progress" }, { conclusion: "failure" },
    { conclusion: "neutral" }, { conclusion: "skipped" }, { conclusion: "cancelled" },
  ]) {
    const checks = fixtures();
    Object.assign(checks[0], patch);
    assert.throws(() => selectDepotChecks(checks, sha, repository));
  }
  for (const conclusion of ["failure", "cancelled", null]) {
    const checks = fixtures();
    const newer = { ...checks[0], id: 100, conclusion, status: conclusion ? "completed" : "in_progress" };
    assert.throws(() => selectDepotChecks([...checks, newer], sha, repository), /Missing successful/);
  }
});

test("different Depot workflows, suites, organizations and duplicate jobs cannot be combined", () => {
  for (const alter of [
    (checks: ReturnType<typeof fixtures>) => { checks[0].details_url = checks[0].details_url.replace("abc123", "another"); },
    (checks: ReturnType<typeof fixtures>) => { checks[0].check_suite.id = 21; },
    (checks: ReturnType<typeof fixtures>) => { checks[0].details_url = checks[1].details_url; },
    (checks: ReturnType<typeof fixtures>) => { checks[0].details_url = checks[0].details_url.replace(depotOrganization, "another"); },
    (checks: ReturnType<typeof fixtures>) => { checks[0].details_url = checks[0].details_url.replace("https://depot.dev", "https://depot.dev.example"); },
    (checks: ReturnType<typeof fixtures>) => { checks[0].details_url = checks[0].details_url.replace("admitflow", "other"); },
  ]) {
    const checks = fixtures(); alter(checks);
    assert.throws(() => selectDepotChecks(checks, sha, repository));
  }
});

test("PR-branch suites and incomplete or mismatched suites cannot authorize main publication", () => {
  const checks = fixtures();
  for (const patch of [
    { head_branch: "codex/security-remediation" }, { head_sha: "b".repeat(40) },
    { id: 21 }, { status: "in_progress" }, { conclusion: "failure" },
    { app: { id: 1, slug: "fake" } },
  ]) assert.throws(() => requireMainSuite({ ...suite(), ...patch }, checks, sha), /on main/);
  assert.throws(() => selectDepotChecks(checks, "main", repository));
  assert.throws(() => selectDepotChecks(checks, sha, "another/repository"));
});
