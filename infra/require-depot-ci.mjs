import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Observed on real Depot checks for this repository. Names alone are not trusted.
export const depotCheckApp = { id: 219785, slug: "depot-code-access" };
export const depotOrganization = "xsf8b0w7g9";
export const requiredChecks = [
  "CI / Tests, typechecks and builds",
  "CI / Browser regression tests",
  "CI / Secrets and dependency audit",
  "CI / Container compatibility and vulnerability scan",
];

/** @param {any[]} checks @param {string} sha @param {string} repository */
export function selectDepotChecks(checks, sha, repository) {
  if (!/^[a-f0-9]{40}$/.test(sha) || repository !== "Deepak8858/admitflow") {
    throw new Error("Expected the exact AdmitFlow release commit.");
  }
  const selected = requiredChecks.map(name => {
    const latest = checks
      .filter(check => check.name === name && check.app?.id === depotCheckApp.id && check.app?.slug === depotCheckApp.slug)
      .sort((a, b) => b.id - a.id)[0];
    if (!latest || latest.head_sha !== sha || latest.status !== "completed" || latest.conclusion !== "success") {
      throw new Error(`Missing successful current Depot check: ${name}`);
    }
    if (!Number.isSafeInteger(latest.id) || !Number.isSafeInteger(latest.check_suite?.id)) {
      throw new Error("Depot check identity is incomplete.");
    }
    const url = new URL(latest.details_url);
    if (url.origin !== "https://depot.dev" || url.username || url.password || url.hash
      || !new RegExp(`^/orgs/${depotOrganization}/workflows/[a-z0-9]+$`).test(url.pathname)
      || url.searchParams.get("repo") !== repository || !/^[a-z0-9]+$/.test(url.searchParams.get("job") || "")) {
      throw new Error("Depot check belongs to an unexpected organization or repository.");
    }
    return { check: latest, workflow: url.pathname, job: url.searchParams.get("job") };
  });
  if (new Set(selected.map(item => item.workflow)).size !== 1
    || new Set(selected.map(item => item.check.check_suite.id)).size !== 1
    || new Set(selected.map(item => item.job)).size !== requiredChecks.length) {
    throw new Error("Required checks must come from one complete Depot workflow.");
  }
  return selected.map(item => item.check);
}

/** @param {any} suite @param {any[]} checks @param {string} sha */
export function requireMainSuite(suite, checks, sha) {
  if (suite.id !== checks[0]?.check_suite?.id || suite.head_sha !== sha || suite.head_branch !== "main"
    || suite.app?.id !== depotCheckApp.id || suite.app?.slug !== depotCheckApp.slug
    || suite.status !== "completed" || suite.conclusion !== "success") {
    throw new Error("A completed successful Depot check suite on main is required.");
  }
}

/** @param {string} path @param {string} token */
async function githubJson(path, token) {
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`GitHub CI verification failed (${response.status}).`);
  return response.json();
}

async function main() {
  const { GITHUB_REPOSITORY: repository, GITHUB_SHA: sha, GITHUB_REF: ref, GH_TOKEN: token } = process.env;
  if (repository !== "Deepak8858/admitflow" || !sha || !/^[a-f0-9]{40}$/.test(sha) || ref !== "refs/heads/main" || !token) {
    throw new Error("Run this gate from the authenticated main-only release workflow.");
  }
  const mainCommit = await githubJson(`repos/${repository}/git/ref/heads/main`, token);
  if (mainCommit.object?.sha !== sha) throw new Error("main moved; release its current reviewed commit.");
  const checks = [];
  for (let page = 1; ; page++) {
    if (page > 100) throw new Error("CI check history is too large to verify completely.");
    const result = await githubJson(`repos/${repository}/commits/${sha}/check-runs?filter=all&per_page=100&page=${page}`, token);
    if (!Array.isArray(result.check_runs)) throw new Error("GitHub did not return CI checks.");
    checks.push(...result.check_runs);
    if (result.check_runs.length < 100) break;
  }
  const selected = selectDepotChecks(checks, sha, repository);
  const suite = await githubJson(`repos/${repository}/check-suites/${selected[0].check_suite.id}`, token);
  requireMainSuite(suite, selected, sha);
  console.log(`Verified all four Depot CI checks on main commit ${sha}.`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
