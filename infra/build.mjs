import { build } from "esbuild";
import { resolve } from "node:path";

// Keep npm dependencies external, so BullMQ scripts and PDF/native package assets remain intact.
// This compiles the actual worker entry point; a Next standalone trace does not include the worker.
await build({
  absWorkingDir: resolve(import.meta.dirname, ".."),
  entryPoints: {
    worker: "scripts/worker.ts",
    migrate: "scripts/migrate.ts",
    "migrate-sqlite": "scripts/migrate-sqlite.ts",
    payments: "scripts/payments.ts",
    preflight: "scripts/preflight.ts",
  },
  outdir: process.argv[2] || "dist", outExtension: { ".js": ".mjs" },
  bundle: true, packages: "external", platform: "node", target: "node24", format: "esm",
  sourcemap: true, sourcesContent: false, tsconfig: "tsconfig.json", logLevel: "info",
});
