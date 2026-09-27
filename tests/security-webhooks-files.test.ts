import test from "node:test";
import assert from "node:assert/strict";
import { createWorkspace } from "../src/lib/seed";
import { beginUpload, downloadUrl } from "../src/lib/files";
import { loadWorkspace, mutateWorkspace, saveNewWorkspace } from "../src/lib/store";

test("file object keys cannot traverse or escape the selected workspace", async t => {
  const values = {
    DATABASE_URL: undefined,
    ADMITFLOW_DB: ":memory:",
    R2_ACCOUNT_ID: "a".repeat(32),
    R2_ACCESS_KEY_ID: "fixture-access",
    R2_SECRET_ACCESS_KEY: "fixture-secret",
    R2_BUCKET: "fixture-bucket",
  };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("No external requests permitted"); });
  const workspace = createWorkspace(false);
  saveNewWorkspace(workspace);
  const upload = await beginUpload(workspace.id, { name: "..", size: 1, mime: "text/plain", purpose: "knowledge" });
  const stored = (await loadWorkspace(workspace.id)).files!.find(file => file.id === upload.id)!;
  assert.equal(stored.objectKey, `${workspace.id}/pending/${upload.id}/file`);
  const badKeys = [
    `${workspace.id}/files/${upload.id}/../secret.txt`,
    `${workspace.id}/files/${upload.id}/./secret.txt`,
    `${workspace.id}/files/not-${upload.id}/secret.txt`,
    `another-workspace/files/${upload.id}/secret.txt`,
  ];
  for (const key of badKeys) {
    await mutateWorkspace(workspace.id, current => {
      const file = current.files!.find(item => item.id === upload.id)!;
      file.status = "ready";
      file.objectKey = key;
    });
    await assert.rejects(() => downloadUrl(workspace.id, upload.id), /File not found/);
  }
  await mutateWorkspace(workspace.id, current => {
    current.files!.find(item => item.id === upload.id)!.objectKey = `${workspace.id}/files/${upload.id}/safe.txt`;
  });
  assert.match(await downloadUrl(workspace.id, upload.id), /^https:/);
});
