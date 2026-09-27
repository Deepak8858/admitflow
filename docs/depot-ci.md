# Native Depot CI for AdmitFlow

AdmitFlow uses **native Depot CI** from [`.depot/workflows/ci.yml`](../.depot/workflows/ci.yml). The former `.github/workflows/ci.yml` was removed; Depot reads the GitHub repository and runs all four CI jobs on Depot sandboxes. GitHub Actions billing prevents scheduling the remaining manual image publisher. The [deployment runbook](deployment.md) and [release gates](release-gates.md) remain the source of truth for publication and production operations.

## Connect and trigger

1. **GitHub Code Access is connected:** authenticated `depot ci migrate preflight` succeeded for the private `Deepak8858/admitflow` repository in Depot organization `xsf8b0w7g9` (`voiceforge`). This confirms the Code Access installation and repository configuration at preflight time.
2. The CLI migrated **CI only** to `.depot/workflows/ci.yml`, changing all four job runners to `depot-ubuntu-24.04`. The workflow declares `pull_request` targeting `main`, `push` to `main`, and `workflow_dispatch`. Both a dispatch on the pushed `codex/security-remediation` branch and an automatic `pull_request` run completed successfully **before merge**. The `main` push trigger still needs observation after merge.
3. Inspect each run's ref, SHA, four jobs and GitHub checks. A check appearing does not make it a required merge check; repository branch protection must be verified separately. Keep merge decisions operator-controlled while protection is unavailable.

Use the authenticated Depot CLI to inspect or run CI:

```sh
depot ci run --workflow .depot/workflows/ci.yml
depot ci run list --org xsf8b0w7g9 --repo Deepak8858/admitflow
depot ci status <run-id> --org xsf8b0w7g9
depot ci logs <run-id> --job verify --org xsf8b0w7g9
depot ci diagnose --run <run-id> --org xsf8b0w7g9
depot ci dispatch --org xsf8b0w7g9 --repo Deepak8858/admitflow --workflow ci.yml --ref codex/security-remediation --output json
```

`depot ci run` submits the local working tree, including uncommitted changes; record the actual run SHA and distinguish a local patch run from a branch dispatch or repository-triggered run. `depot ci status` identifies job attempts, and `depot ci logs <attempt-id>` gives precise attempt output. `depot ci dispatch` uses the workflow **basename**, `ci.yml`, and the requested pushed branch or tag; it starts CI, not image publication.

## CI and publication boundaries

The [native workflow](../.depot/workflows/ci.yml) runs isolated tests, browser fixtures, a redacted history scan, dependency audit, image smoke tests, and image vulnerability scans. It should receive only the permissions needed to read source and report checks. Preserve checkout without persisted credentials, pinned third-party actions and downloads, and redacted secret-scan output. Its security job explicitly validates Depot and remaining GitHub workflow YAML with `actionlint`. Retain browser failure traces and complete image-scan reports as artifacts.

The [manual image publisher](../.github/workflows/publish-images.yml) remains a **GitHub Actions** workflow and is blocked from future scheduling by the current billing state. It keeps the `PUBLISH` confirmation, `BUILDS_APPROVED` cost gate, scoped temporary AWS/Depot access, digest and scan review, and later ECS/migration/DNS approvals. Its [CI gate](../infra/require-depot-ci.mjs) now checks the exact current `main` SHA and the latest four successful checks from trusted Depot Code Access app ID `219785` (`depot-code-access`), requiring one workflow/check suite and a successful suite on `main`. This check-suite condition does **not** independently prove the suite was triggered by a `push` event. Verify the adapted gate in a runnable release workflow before relying on it. Native CI success alone neither publishes images nor authorizes production changes. `depot ci migrate secrets-and-vars` starts a one-shot GitHub Actions workflow, so it does not bypass this billing block.

## Compatibility and verification limits

Depot's [compatibility reference](https://depot.dev/docs/ci/compatibility.md) supports the three triggers above and marketplace actions, but requires Depot runner labels and does not currently support PR workflows from forks, cross-repository reusable workflows, or job `environment`. Check the actual workflow against these limits, including installed tools, action behavior, artifacts, and permission scopes. GitHub Packages does not accept Depot's GitHub App token.

## Verification record

- **Confirmed setup and dispatch:** authenticated Code Access preflight and CI-only migration; branch dispatch returned run `xh0m032dqn` / workflow `ghkwvw8nxj` for exact commit `249a8441b1db076f5fa0ecf6366569de706f5547`.
- **First-run repair:** three jobs passed, while `Tests, typechecks and builds` exposed a pagination fixture whose seeded lead sat exactly on a 14-day scoring boundary. The fixture now moves that lead one day away from the boundary; production scoring and assertions are unchanged.
- **Successful branch dispatch:** run `46nktn6jn6` / [workflow `c51dmqmwmh`](https://depot.dev/orgs/xsf8b0w7g9/workflows/c51dmqmwmh) passed all four jobs for commit `0ebf95f2c3aa280e3750548c9deebc6b3a965b4d`. Verification includes 371 application tests, 120 infrastructure tests, 646 offline IAM checks, three Python tests, both typechecks, production/service builds and all 14 migration dry runs.
- **Successful automatic PR trigger:** run `k4xcqw5zzb` / [workflow `v16brltjms`](https://depot.dev/orgs/xsf8b0w7g9/workflows/v16brltjms) ran on `refs/pull/13/merge`, merge commit `9f766fbb55a0a2a0ddaf4b6f9f112f5eef199f4a`, with head `0ebf95f2c3aa280e3750548c9deebc6b3a965b4d`. All four jobs passed. Browser logs show 62 main and 10 account-flow checks passing in one run. Retained Trivy reports inventory web 28 OS / 58 Node packages and worker 28 OS / 236 Node packages, with zero reported vulnerabilities.
- **GitHub checks and gate:** the successful automatic run reported `CI / Tests, typechecks and builds`, `CI / Browser regression tests`, `CI / Secrets and dependency audit`, and `CI / Container compatibility and vulnerability scan`. The gate accepted all four actual checks from suite `98383597938` and correctly rejected that suite's PR branch for publication. The main-only publisher has not run.
- **Separate unresolved check:** GitGuardian reported four findings across the PR's four commits at this head. Its GitHub check returned no finding locations or annotations. Browser inspection was stopped by the computer-use URL-safety check, so the findings have not been classified, remediated or dismissed. Depot's passing redacted Gitleaks scan does not resolve them.
- **Still to record:** the `main` push trigger after merge and a runnable check of the publisher gate. The `main` suite requirement alone does not establish push-event provenance. This migration did not merge the PR, publish images or deploy production.

Local syntax checks or historical GitHub Actions runs cannot establish Depot execution. Depot's [quickstart](https://depot.dev/docs/ci/quickstart.md) and [CLI reference](https://depot.dev/docs/cli/reference/depot-ci.md) describe the setup and inspection commands.
