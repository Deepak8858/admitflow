import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const media = path.join(root, "public", "media");
const manifestPath = path.join(media, "image-provenance.json");
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
for (const asset of manifest.assets) {
  if (asset.status !== "completed" || !asset.file) continue;
  if (!/^[a-z0-9-]+$/.test(asset.slug)) throw new Error("Invalid asset slug");
  const original = await fs.readFile(path.join(media, `${asset.slug}.png`));
  if (createHash("sha256").update(original).digest("hex") !== asset.sha256) {
    throw new Error(`Original asset changed: ${asset.slug}`);
  }
  const metadata = await sharp(original).metadata();
  const variants = [];
  for (const [suffix, width] of [["", 1536], ["-small", 640]]) {
    const filename = `${asset.slug}${suffix}.webp`;
    const output = await sharp(original)
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .modulate({ saturation: 0.96 })
      .webp({ quality: 84, effort: 6 })
      .toBuffer({ resolveWithObject: true });
    try {
      await fs.writeFile(path.join(media, filename), output.data, { flag: "wx" });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await fs.readFile(path.join(media, filename));
      if (!existing.equals(output.data)) throw new Error(`Refusing to overwrite changed variant: ${filename}`);
    }
    variants.push({ file: `public/media/${filename}`, width: output.info.width,
      height: output.info.height, bytes: output.data.length,
      sha256: createHash("sha256").update(output.data).digest("hex") });
    console.log(`${filename}: ${output.info.width}x${output.info.height}, ${output.data.length} bytes`);
  }
  Object.assign(asset, { width: metadata.width, height: metadata.height, variants,
    processing: "Auto-orient; resize without enlargement; saturation 0.96; WebP quality 84; original PNG retained." });
}
await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
