import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";

function getKey() {
  const explicit = process.env.TOKEN_ENCRYPTION_KEY;

  if (explicit) {
    const decoded = Buffer.from(explicit, "base64");
    if (decoded.length === 32) {
      return decoded;
    }
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("TOKEN_ENCRYPTION_KEY must be a base64 encoded 32-byte key in production.");
  }

  return crypto.createHash("sha256").update(process.env.AUTH_SECRET ?? "jobmatch-local-dev").digest();
}

export function encryptToken(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(".");
}

export function decryptToken(value: string) {
  const [ivValue, tagValue, encryptedValue] = value.split(".");

  if (!ivValue || !tagValue || !encryptedValue) {
    throw new Error("Encrypted token is malformed.");
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivValue, "base64"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64")),
    decipher.final()
  ]).toString("utf8");
}
