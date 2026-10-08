import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const VERSION = "v1";

/**
 * Encrypts a secret for storage. Output: "v1.<iv>.<authTag>.<ciphertext>" (base64url parts).
 * The version prefix leaves room for key rotation later.
 */
export function encryptSecret(plaintext: string, keyBase64: string): string {
  const key = Buffer.from(keyBase64, "base64");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, ciphertext].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

export function decryptSecret(payload: string, keyBase64: string): string {
  const [version, iv, tag, ciphertext] = payload.split(".");
  if (version !== VERSION || !iv || !tag || !ciphertext) {
    throw new Error("Unrecognized encrypted secret format");
  }
  const key = Buffer.from(keyBase64, "base64");
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

export const API_KEY_PREFIX = "zic_";

/** A new connector API key. Only `hash` is stored; `key` is shown to the merchant once. */
export function generateApiKey(): { key: string; hash: string; displayPrefix: string } {
  const key = `${API_KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
  return { key, hash: hashApiKey(key), displayPrefix: key.slice(0, API_KEY_PREFIX.length + 6) };
}

/**
 * SHA-256 is appropriate here (unlike for passwords): keys are 192 random bits,
 * so brute-forcing the hash is infeasible and a fast lookup by hash is what we need.
 */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function randomState(): string {
  return randomBytes(32).toString("base64url");
}
