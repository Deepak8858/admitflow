import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";
config({ path: ".env.local" });
export default defineConfig({ dialect: "postgresql", schema: "./src/lib/db/schema.ts", out: "./drizzle", dbCredentials: { url: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || "postgres://localhost/admitflow" }, strict: true });
