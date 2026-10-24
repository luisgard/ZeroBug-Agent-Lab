/**
 * Encrypts connection secrets at rest (AES-256-GCM). The key comes from ZB_SECRET_KEY (32 bytes,
 * base64) or, for local use, a key file created once with owner-only permissions.
 * Secrets are decrypted only inside the server process and never sent to the browser.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class SecretBox {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error("Secret key must be 32 bytes");
  }

  static fromEnvOrFile(env: NodeJS.ProcessEnv = process.env, file = env.ZB_SECRET_KEY_FILE ?? "data/.zb-secret.key"): SecretBox {
    if (env.ZB_SECRET_KEY) return new SecretBox(Buffer.from(env.ZB_SECRET_KEY, "base64"));
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, randomBytes(32).toString("base64"), { mode: 0o600, flag: "wx" });
      console.warn(`[zerobug] Created a local secret key at ${file}. Set ZB_SECRET_KEY in production.`);
    }
    chmodSync(file, 0o600);
    return new SecretBox(Buffer.from(readFileSync(file, "utf8").trim(), "base64"));
  }

  seal(value: unknown): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
    return `v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64")}`;
  }

  open<T = unknown>(sealed: string): T {
    if (!sealed.startsWith("v1:")) throw new Error("Unknown secret format");
    const raw = Buffer.from(sealed.slice(3), "base64");
    const d = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8")) as T;
  }
}
