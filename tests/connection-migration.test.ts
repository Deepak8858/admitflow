import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../src/lib/db/schema";
import { createWorkspace } from "../src/lib/seed";
import { uid, isoNow } from "../src/lib/domain";

test("connection migration rejects legacy orphan receipts without deleting or rebinding evidence", async () => {
  const pg = new PGlite();
  try {
    for (const file of (await readdir("drizzle")).filter(file => file.endsWith(".sql") && file < "0009").sort()) await pg.exec(await readFile(`drizzle/${file}`, "utf8"));
    const db = drizzle(pg, { schema }), workspace = createWorkspace(false);
    await db.insert(schema.organizations).values({ id: workspace.id, name: "Legacy institute", ownerName: "Owner", demo: false, sequence: workspace.sequence, ai: workspace.ai!, subscription: workspace.subscription! });
    await db.insert(schema.intakeInbox).values({ id: "legacy-orphan", organizationId: workspace.id, connectionId: uid(), service: "whatsapp", externalId: "111", contactKey: "+919876543210", receivedAt: isoNow(), state: "deferred", payload: { service: "whatsapp", event: { id: "legacy", from: "919876543210", body: "Retained enquiry", verified: true } } });
    const before = await db.select().from(schema.intakeInbox);
    const migration = await readFile("drizzle/0009_connection_binding.sql", "utf8");
    await assert.rejects(() => pg.transaction(tx => tx.exec(migration)), /foreign key constraint/);
    assert.deepEqual(await db.select().from(schema.intakeInbox), before);
    assert.equal((await db.select().from(schema.connections)).length, 0);
    const result = await pg.query<{ present: string | null }>("select to_regclass('public.connections_tenant_binding')::text as present");
    assert.equal(result.rows[0].present, null, "the failed migration rolls back its new index too");
  } finally { await pg.close(); }
});
