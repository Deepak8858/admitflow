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
    await pg.query("insert into intake_inbox (id, organization_id, connection_id, service, external_id, contact_key, received_at, state, payload) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)", ["legacy-orphan", workspace.id, uid(), "whatsapp", "111", "+919876543210", isoNow(), "deferred", JSON.stringify({ service: "whatsapp", event: { id: "legacy", from: "919876543210", body: "Retained enquiry", verified: true } })]);
    const before = (await pg.query("select * from intake_inbox")).rows;
    const migration = await readFile("drizzle/0009_connection_binding.sql", "utf8");
    await assert.rejects(() => pg.transaction(tx => tx.exec(migration)), /foreign key constraint/);
    assert.deepEqual((await pg.query("select * from intake_inbox")).rows, before);
    assert.equal((await db.select().from(schema.connections)).length, 0);
    const result = await pg.query<{ present: string | null }>("select to_regclass('public.connections_tenant_binding')::text as present");
    assert.equal(result.rows[0].present, null, "the failed migration rolls back its new index too");
  } finally { await pg.close(); }
});
