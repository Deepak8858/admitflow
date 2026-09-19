import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { KMSClient, EncryptCommand, DecryptCommand } from "@aws-sdk/client-kms";
import { AppError } from "./errors";

function localKey() {
  const key = Buffer.from(process.env.INTEGRATION_ENCRYPTION_KEY || "", "base64");
  if (key.length !== 32) throw new AppError("Configure a 32-byte INTEGRATION_ENCRYPTION_KEY or AWS KMS_KEY_ID before saving credentials.", 503);
  return key;
}
export async function sealSecret(value: Record<string, string>, organizationId: string) {
  const text = JSON.stringify(value);
  if (process.env.KMS_KEY_ID) {
    const result = await new KMSClient({}).send(new EncryptCommand({ KeyId: process.env.KMS_KEY_ID, Plaintext: Buffer.from(text), EncryptionContext: { organizationId } }));
    return `kms:${Buffer.from(result.CiphertextBlob!).toString("base64")}`;
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", localKey(), iv);
  cipher.setAAD(Buffer.from(organizationId));
  const ciphertext = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${ciphertext.toString("base64")}`;
}
export async function openSecret(value: string, organizationId: string): Promise<Record<string, string>> {
  if (value.startsWith("kms:")) {
    const result = await new KMSClient({}).send(new DecryptCommand({ CiphertextBlob: Buffer.from(value.slice(4), "base64"), EncryptionContext: { organizationId } }));
    return JSON.parse(Buffer.from(result.Plaintext!).toString());
  }
  const [version, iv, tag, ciphertext] = value.split(":");
  if (version !== "v1") throw new AppError("This connection needs to be configured again.", 409);
  const decipher = createDecipheriv("aes-256-gcm", localKey(), Buffer.from(iv, "base64"));
  decipher.setAAD(Buffer.from(organizationId)); decipher.setAuthTag(Buffer.from(tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString());
}
