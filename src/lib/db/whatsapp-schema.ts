import { sql } from "drizzle-orm";
import { pgTable, uuid, text, foreignKey, uniqueIndex, check } from "drizzle-orm/pg-core";
import { organizations, connections } from "./schema";
import { instant } from "./instant";

/** Durable subscription evidence, never synchronized from the workspace aggregate. */
export const whatsappSubscriptionOperations = pgTable("whatsapp_subscription_operations", {
  id: uuid("id").primaryKey(), organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id").notNull(), service: text("service").notNull().default("whatsapp"), externalId: text("external_id").notNull(),
  wabaId: text("waba_id").notNull(), appId: text("app_id").notNull(), generation: uuid("generation").notNull(), dispatchGeneration: uuid("dispatch_generation"),
  createdAt: instant("created_at").notNull(), dispatchedAt: instant("dispatched_at"), confirmedAt: instant("confirmed_at"), observedAt: instant("observed_at"), checkedAt: instant("checked_at"),
  reconciliation: text("reconciliation").$type<"reserved" | "uncertain" | "confirmed" | "present" | "absent">().notNull().default("reserved"),
}, table => [
  ...[table.createdAt, table.dispatchedAt, table.confirmedAt, table.observedAt, table.checkedAt].map(column => check(`${column.name}_finite`, sql`isfinite(${column}) and ${column} >= '0001-01-01T00:00:00Z'::timestamptz and ${column} < '10000-01-01T00:00:00Z'::timestamptz`)),
  uniqueIndex("whatsapp_subscription_tenant").on(table.organizationId),
  uniqueIndex("whatsapp_subscription_account_app").on(table.wabaId, table.appId),
  foreignKey({ name: "whatsapp_subscription_connection", columns: [table.organizationId, table.connectionId, table.service, table.externalId], foreignColumns: [connections.organizationId, connections.id, connections.service, connections.externalId] }),
  check("whatsapp_subscription_service", sql`${table.service} = 'whatsapp'`),
  check("whatsapp_subscription_identity", sql`${table.externalId} ~ '^[0-9]{1,80}$' and ${table.wabaId} ~ '^[0-9]{1,80}$' and ${table.appId} ~ '^[0-9]{1,80}$'`),
  check("whatsapp_subscription_state", sql`${table.reconciliation} in ('reserved', 'uncertain', 'confirmed', 'present', 'absent')`),
  check("whatsapp_subscription_confirmation", sql`${table.confirmedAt} is null or ${table.dispatchedAt} is not null`),
  check("whatsapp_subscription_dispatch", sql`(${table.dispatchedAt} is null) = (${table.dispatchGeneration} is null)`),
]);
