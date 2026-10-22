import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SkillInfo } from "../shared.ts";

/**
 * Skills are folders containing a SKILL.md with YAML-ish frontmatter (name, description) —
 * the same layout as Anthropic Agent Skills, so existing skills drop straight in.
 * Only names + descriptions go in the system prompt; bodies load on demand.
 */
export class Skills {
  private cache: (SkillInfo & { body: string })[] | null = null;

  constructor(private dirs: { path: string; builtin: boolean }[]) {}

  reload() {
    this.cache = null;
  }

  list(): SkillInfo[] {
    return this.all().map(({ body: _b, ...s }) => s);
  }

  private all() {
    if (this.cache) return this.cache;
    const out: (SkillInfo & { body: string })[] = [];
    for (const d of this.dirs) {
      if (!existsSync(d.path)) continue;
      for (const entry of readdirSync(d.path)) {
        const file = join(d.path, entry, "SKILL.md");
        if (!existsSync(file) || !statSync(file).isFile()) continue;
        const raw = readFileSync(file, "utf8");
        const { meta, body } = parseFrontmatter(raw);
        const name = meta.name || entry;
        if (out.some((s) => s.name === name)) continue; // user skills shadow built-ins (user dir listed first)
        out.push({ name, description: meta.description || body.split("\n").find((l) => l.trim())?.slice(0, 200) || "", path: file, builtin: d.builtin, body });
      }
    }
    this.cache = out;
    return out;
  }

  read(name: string): string {
    const s = this.all().find((x) => x.name === name);
    if (!s) return `No skill named "${name}". Available: ${this.all().map((x) => x.name).join(", ")}`;
    return s.body;
  }

  promptList(): string {
    const s = this.all();
    if (!s.length) return "";
    return s.map((x) => `- ${x.name}: ${x.description}`).join("\n");
  }
}

export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return { meta, body: raw.slice(m[0].length) };
}
