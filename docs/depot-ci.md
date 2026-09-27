# Native Depot CI for AdmitFlow

AdmitFlow uses **native Depot CI** from [`.depot/workflows/ci.yml`](../.depot/workflows/ci.yml). The former `.github/workflows/ci.yml` was removed; Depot reads the GitHub repository and runs all four CI jobs on Depot sandboxes. GitHub Actions billing prevents scheduling the remaining manual image publisher. The [deployment runbook](deployment.md) and [release gates](release-gates.md) remain the source of truth for publication and production operations.

## Connect and trigger

1. **GitHub Code Access is connected:** authenticated `depot ci migrate preflight` succeeded for the private `Deepak8858/admitflow` repository in Depot organization `xsf8b0w7g9` (`voiceforge`). This confirms the Code Access installation and repository configuration at preflight time.
2. The CLI migrated **CI only** to `.depot/workflows/ci.yml`, changing all four job runners to `depot-ubuntu-24.04`. The workflow declares `pull_request` targeting `main`, `push` to `main`, and `workflow_dispatch`. A dispatch on the pushed `codex/security-remediation` branch succeeded **before merge**. Automatic PR and `main` push triggers still need observation after the native workflow reaches the default branch; dispatch does not prove either event.
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
- **Observed on that run:** browser regression tests passed all 72; security passed; containers built, passed smoke tests and retained scan reports. Scan inventories were web 28 OS / 58 npm and worker 28 OS / 236 npm, with zero reported vulnerabilities. GitHub reported the four Depot checks as `CI / Tests, typechecks and builds`, `CI / Browser regression tests`, `CI / Secrets and dependency audit`, and `CI / Container compatibility and vulnerability scan`.
- **Not green yet:** `Tests, typechecks and builds` failed on pagination-test timing. A fix and a complete rerun are pending; the other three jobs do not make the workflow successful.
- **Still to record:** green rerun ID and exact SHA; automatic PR and `main` push trigger evidence after merge; and a runnable check of the publisher gate. The `main` suite requirement alone does not establish push-event provenance.

Local syntax checks or historical GitHub Actions runs cannot establish Depot execution. Depot's [quickstart](https://depot.dev/docs/ci/quickstart.md) and [CLI reference](https://depot.dev/docs/cli/reference/depot-ci.md) describe the setup and inspection commands.
