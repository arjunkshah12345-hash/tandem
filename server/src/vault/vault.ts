import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import type { DB } from "../db.ts";

/**
 * Encrypted secret store. Secrets (API keys, passwords, OAuth tokens) are AES-256-GCM
 * encrypted at rest and are NEVER placed in a model's context. Tools and connectors refer
 * to them by name (`{{secret:NAME}}`) and the value is substituted only at execution time,
 * outside the model loop.
 */
export class Vault {
  private key: Buffer;

  constructor(
    private db: DB,
    keyFile: string,
  ) {
    const fromEnv = process.env.TANDEM_SECRET_KEY;
    if (fromEnv) {
      this.key = scryptSync(fromEnv, "tandem-vault", 32);
    } else if (existsSync(keyFile)) {
      this.key = Buffer.from(readFileSync(keyFile, "utf8").trim(), "base64");
    } else {
      this.key = randomBytes(32);
      writeFileSync(keyFile, this.key.toString("base64"), { mode: 0o600 });
      try {
        chmodSync(keyFile, 0o600);
      } catch {}
    }
  }

  set(name: string, value: string): void {
    assertName(name);
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const enc = Buffer.concat([c.update(value, "utf8"), c.final()]);
    const blob = Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
    this.db
      .prepare(
        "INSERT INTO secrets (name, value, created_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
      )
      .run(name, blob, Date.now());
  }

  get(name: string): string | null {
    const row = this.db.prepare("SELECT value FROM secrets WHERE name = ?").get(name) as { value: string } | undefined;
    if (!row) return process.env[name] || null; // allow env-provided secrets
    const buf = Buffer.from(row.value, "base64");
    const d = createDecipheriv("aes-256-gcm", this.key, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
  }

  has(name: string): boolean {
    return this.get(name) !== null;
  }

  delete(name: string): void {
    this.db.prepare("DELETE FROM secrets WHERE name = ?").run(name);
  }

  list(): { name: string; createdAt: number }[] {
    return (this.db.prepare("SELECT name, created_at FROM secrets ORDER BY name").all() as any[])
      .filter((r) => !r.name.startsWith("mcp_oauth_"))
      .map((r) => ({ name: r.name, createdAt: r.created_at }));
  }

  /** Replace {{secret:NAME}} placeholders. Throws if a referenced secret is missing. */
  resolve(template: string): string {
    return template.replace(/\{\{secret:([A-Za-z0-9_.-]+)\}\}/g, (_, n: string) => {
      const v = this.get(n);
      if (v === null) throw new Error(`Missing secret "${n}". Add it in Settings → Secrets.`);
      return v;
    });
  }

  resolveRecord(rec: Record<string, string> | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(rec ?? {})) out[k] = this.resolve(v);
    return out;
  }

  /** All secret values currently stored — used to scrub tool output before the model sees it. */
  allValues(): string[] {
    const names = (this.db.prepare("SELECT name FROM secrets").all() as any[]).map((r) => r.name as string);
    return names.map((n) => this.get(n)).filter((v): v is string => !!v && v.length >= 6);
  }
}

function assertName(name: string) {
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(name)) throw new Error("Secret names may only contain letters, digits, _ . -");
}
