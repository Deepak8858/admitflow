import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** @typedef {{ open: (filename: string, flags: string) => Promise<Pick<import('node:fs/promises').FileHandle, 'writeFile' | 'sync' | 'close'>>, rename: typeof fs.rename, rm: typeof fs.rm }} AtomicJsonIO */
/** @param {string} filename @param {unknown} value @param {AtomicJsonIO} io @param {NodeJS.Platform} platform */
export async function writeJsonAtomic(filename, value, io = fs, platform = process.platform) {
  const content = JSON.stringify(value, null, 2) + "\n";
  const directory = path.dirname(filename);
  const temporary = path.join(directory, `.${path.basename(filename)}.${randomUUID()}.tmp`);
  // If exclusive creation fails, this call does not own the path and must not remove it.
  const file = await io.open(temporary, "wx");
  try {
    try {
      await file.writeFile(content);
      await file.sync();
    } finally { await file.close(); }
    // Publish only after the complete document is flushed and its handle is closed.
    await io.rename(temporary, filename);
    // Node cannot open directories for fsync on Windows. POSIX also requires flushing
    // the renamed directory entry; failure means publication durability is uncertain.
    if (platform !== "win32") {
      const parent = await io.open(directory, "r");
      try { await parent.sync(); } finally { await parent.close(); }
    }
  } finally {
    await io.rm(temporary, { force: true });
  }
}
