import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** @param {string} filename @param {unknown} value @param {Pick<typeof fs, 'writeFile' | 'rename' | 'rm'>} io */
export async function writeJsonAtomic(filename, value, io = fs) {
  const content = JSON.stringify(value, null, 2) + "\n";
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`);
  try {
    await io.writeFile(temporary, content, { flag: "wx" });
    // Same-directory rename publishes the complete document without a truncate/write window.
    await io.rename(temporary, filename);
  } finally {
    await io.rm(temporary, { force: true });
  }
}
