#!/usr/bin/env bash
set -euo pipefail
web="${1:?Usage: smoke-images.sh WEB_IMAGE WORKER_IMAGE}"
worker="${2:?Worker image is required}"
container="admitflow-security-smoke-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}"
trap 'docker rm --force "$container" >/dev/null 2>&1 || true' EXIT

for image in "$web" "$worker"; do
  docker run --rm --entrypoint node "$image" --input-type=module -e '
    import assert from "node:assert/strict";
    import {readFileSync, existsSync} from "node:fs";
    import {gzipSync, gunzipSync} from "node:zlib";
    assert.equal(process.versions.node.split(".")[0], "24");
    assert.ok(process.getuid() > 0, "The service must run unprivileged");
    assert.ok(process.config.variables.node_shared_zlib, "Node must use patched system zlib");
    const installed = readFileSync("/lib/apk/db/installed", "utf8");
    assert.match(installed, /\nP:zlib\nV:1\.3\.2\.1_rc20260601-r0\n/);
    assert.doesNotMatch(installed, /\nP:perl(?:\n|-)/);
    assert.ok(!existsSync("/usr/bin/perl"));
    const libraries = process.report.getReport().sharedObjects;
    assert.ok(libraries.some(path => /\/libz\.so/.test(path)), "Shared zlib must actually be loaded");
    assert.equal(gunzipSync(gzipSync("admitflow")).toString(), "admitflow");
    assert.equal(new Intl.DateTimeFormat("en-IN", {timeZone:"Asia/Kolkata", year:"numeric"}).format(new Date(0)), "1970");
    console.log(JSON.stringify({node:process.versions.node,zlib:process.versions.zlib,uid:process.getuid()}));
  '
done

# Exercise native modules built on Debian against the new glibc runtime.
docker run --rm --entrypoint node "$web" --input-type=module -e '
  import sharp from "sharp";
  const png = await sharp({create:{width:2,height:2,channels:4,background:"#ffffff"}}).png().toBuffer();
  if ((await sharp(png).metadata()).width !== 2) process.exit(1);
'
docker run --rm --entrypoint node "$worker" --input-type=module -e '
  await import("pdf-parse");
  await import("pg");
  await import("bullmq");
  const {DatabaseSync} = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("select 1"); db.close();
'
# Exercise the real entrypoint and service bundle without connecting to a provider.
docker run --rm -e ADMITFLOW_PROCESS_ROLE=migration \
  -e DATABASE_URL_UNPOOLED=postgres://fixture:fixture@127.0.0.1/fixture \
  "$worker" node dist/payments.mjs --help

docker run --detach --name "$container" --publish 127.0.0.1:3300:3000 \
  -e DATABASE_URL=postgres://fixture:fixture@127.0.0.1/fixture \
  -e REDIS_URL=rediss://fixture:fixture@127.0.0.1:6379 \
  -e WORKOS_API_KEY=sk_test_container_fixture \
  -e WORKOS_CLIENT_ID=client_container_fixture \
  -e WORKOS_COOKIE_PASSWORD=container-smoke-fixture-cookie-key-32-characters \
  -e APP_BASE_URL=https://admitflow.example \
  -e NEXT_PUBLIC_WORKOS_REDIRECT_URI=https://admitflow.example/callback \
  -e 'INTAKE_CONTACT_KEYS=["ERERERERERERERERERERERERERERERERERERERERERE="]' \
  "$web"
healthy=false
for attempt in {1..30}; do
  if curl --fail --silent http://127.0.0.1:3300/api/health > /dev/null; then healthy=true; break; fi
  sleep 2
done
docker logs "$container"
[[ "$healthy" == true ]]
for path in / /signup /login; do
  [[ "$(curl --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:3300$path")" == 200 ]]
done
[[ "$(curl --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1:3300/api/leads)" == 401 ]]
