#!/usr/bin/env bash
# Scan either a locally built image or an immutable ECR digest after publication.
set -euo pipefail
image="${1:?Usage: scan-image.sh IMAGE REPORT.json}"
report="${2:?A JSON report path is required}"
destination="${RUNNER_TEMP:-/tmp}/admitflow-trivy-0.74.0"
mkdir -p "$destination"
if [[ ! -x "$destination/trivy" ]]; then
  curl --fail --silent --show-error --location --retry 3 \
    https://github.com/aquasecurity/trivy/releases/download/v0.74.0/trivy_0.74.0_Linux-64bit.tar.gz \
    --output "$destination/trivy.tar.gz"
  printf '%s  %s\n' '2ae6fe3ee734b7fdf11335663e18c75ea12dccc76062f09f164a3b0f8be4371a' "$destination/trivy.tar.gz" | sha256sum --check
  tar -xzf "$destination/trivy.tar.gz" -C "$destination" trivy
fi
# Retain the complete report; do not ignore unfixed advisories or hide OS packages.
"$destination/trivy" image --scanners vuln --timeout 15m --format json --output "$report" "$image"
# An unsupported/undetected OS must never be reported as a clean image.
jq --exit-status '.Metadata.OS.Family == "wolfi" and any(.Results[]; .Class == "os-pkgs")' "$report" > /dev/null
"$destination/trivy" convert --scanners vuln --format table "$report"
# Enforce the retained JSON directly as well as Trivy's exit code. A reporting
# default must never silently turn a vulnerability scan into an empty summary.
jq --exit-status '[.Results[] | .Vulnerabilities[]? | select(.Severity == "HIGH" or .Severity == "CRITICAL")] | length == 0' "$report" > /dev/null
"$destination/trivy" convert --scanners vuln --severity HIGH,CRITICAL --exit-code 1 "$report"
