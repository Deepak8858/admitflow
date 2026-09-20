import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";
// Push cannot preserve reviewed raw-SQL invariants (RLS/triggers/optional pgvector).
// Reject it before loading local credentials; use generated, reviewed migrations instead.
if (process.argv.slice(2).some(argument => argument === "push" || argument.startsWith("push:"))) {
  throw new Error("drizzle-kit push is disabled. Generate and review SQL with npm run db:generate, then apply it with npm run db:migrate; preserve raw RLS, triggers and optional pgvector objects.");
}
config({ path: ".env.local", quiet: true });
const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
export default defineConfig({
  dialect: "postgresql", schema: "./src/lib/db/schema.ts", out: "./drizzle", strict: true,
  ...(url ? { dbCredentials: { url } } : {}),
});
