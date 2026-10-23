import type { App } from "../app.ts";
import type { Tool } from "../tools/types.ts";
import { obj, str } from "../tools/types.ts";
import { errorMessage } from "../util.ts";

/**
 * Query-aware context compression via the hosted SuperCompress API (https://www.supercompress.dev).
 *
 * Large tool results (web pages, emails, MCP output, browser snapshots) are sent with the current
 * request; SuperCompress keeps the original lines that matter — verbatim — and drops the rest.
 * Always fails open: any error, timeout or low-confidence result means the model gets the original.
 */
export const SUPERCOMPRESS_KEY_SECRET = "SUPERCOMPRESS_API_KEY";
const DEFAULT_URL = "https://www.supercompress.dev/api/v1/compress";
/**
 * The hosted Neural Keep model answers in ~40–50s regardless of input size (measured Oct 2026), so a
 * tighter budget silently skips nearly every call. Background work can wait; a live chat turn
 * (scope "all") gets less. Anything slower still falls back to the original.
 */
const BACKGROUND_TIMEOUT_MS = 120_000;
const INTERACTIVE_TIMEOUT_MS = 60_000;
/** Don't send more than this to the API; the gate truncates anything longer afterwards. */
const MAX_INPUT_CHARS = 400_000;
/** The hosted API rejects contexts over 120k characters (HTTP 422); stay under it with margin. */
const CHUNK_CHARS = 115_000;
const KEEP_ORIGINALS = 40;

interface ApiResponse {
  compressed_text: string;
  original_tokens: number;
  kept_tokens: number;
  tokens_saved_pct?: number;
  compression_risk?: "low" | "medium" | "high";
}

export interface CompressionStats {
  days: Record<string, { calls: number; originalTokens: number; keptTokens: number }>;
}

export interface CompressionStatus {
  enabled: boolean;
  configured: boolean;
  paused: string | null;
  today: { calls: number; originalTokens: number; keptTokens: number };
  last30: { calls: number; originalTokens: number; keptTokens: number };
}

export class Compressor {
  private pausedUntil = 0;
  private pauseReason: string | null = null;
  /** resultId → original (already redacted) text, for get_full_result. */
  private originals = new Map<string, string>();

  constructor(private app: App) {}

  private get url() {
    return process.env.SUPERCOMPRESS_URL || DEFAULT_URL;
  }

  /** SUPERCOMPRESS_TIMEOUT_MS overrides the per-call budget (e.g. for a self-hosted, faster endpoint). */
  private timeout(fallback: number) {
    const n = Number(process.env.SUPERCOMPRESS_TIMEOUT_MS);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  private key(): string | null {
    return this.app.vault.get(SUPERCOMPRESS_KEY_SECRET);
  }

  /** On and usable right now (enabled, key present, not paused). */
  active(): boolean {
    return this.app.settings.get().compression.enabled && !!this.key() && Date.now() >= this.pausedUntil;
  }

  status(): CompressionStatus {
    const s = this.app.settings.get().compression;
    const days = this.stats().days;
    const sum = (keys: string[]) =>
      keys.reduce(
        (a, k) => {
          const d = days[k];
          if (d) {
            a.calls += d.calls;
            a.originalTokens += d.originalTokens;
            a.keptTokens += d.keptTokens;
          }
          return a;
        },
        { calls: 0, originalTokens: 0, keptTokens: 0 },
      );
    const today = dayKey(Date.now());
    const cutoff = dayKey(Date.now() - 29 * 86400_000);
    return {
      enabled: s.enabled,
      configured: !!this.key(),
      paused: Date.now() < this.pausedUntil ? this.pauseReason : null,
      today: sum([today]),
      last30: sum(Object.keys(days).filter((k) => k >= cutoff)),
    };
  }

  /** Clear a pause, e.g. after the user saves a new key. */
  resume() {
    this.pausedUntil = 0;
    this.pauseReason = null;
  }

  original(resultId: string): string | null {
    return this.originals.get(resultId) ?? null;
  }

  /**
   * Compress `text` against `query` if it's big enough and the service is available.
   * Returns the text to show the model (original on any failure).
   */
  async maybeCompress(
    text: string,
    query: string,
    o: { resultId: string; toolName: string; signal?: AbortSignal; interactive?: boolean; truncateAt?: number },
  ): Promise<{ text: string; note: string | null }> {
    const { minChars, scope } = this.app.settings.get().compression;
    if (o.interactive && scope !== "all") return { text, note: null };
    if (text.length < minChars || !query.trim() || !this.active()) return { text, note: null };
    const timeout = o.interactive ? INTERACTIVE_TIMEOUT_MS : BACKGROUND_TIMEOUT_MS;
    // The API rejects contexts over 120k chars, so long results go up in parallel chunks.
    const chunks = splitChunks(text.slice(0, MAX_INPUT_CHARS), CHUNK_CHARS);
    const settled = await Promise.allSettled(chunks.map((c) => this.call(c, query, o.signal, timeout)));
    if (settled.some((s) => s.status === "rejected" && s.reason instanceof PauseError)) return { text, note: null };
    const failed = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
    if (failed) this.app.store.log("system", `Compression skipped for ${o.toolName}`, errorMessage(failed.reason));

    // Per chunk: failed or low-confidence results keep that chunk's original text. An empty answer from
    // a good call means nothing in that chunk was relevant, as long as some other chunk kept something.
    // A "high" risk answer is still better than blind truncation, so it's used when the original
    // wouldn't fit anyway (the note says so, and get_full_result stays available).
    const wouldTruncate = text.length > (o.truncateAt ?? Infinity);
    let lowConfidence = false;
    let originalTokens = 0;
    let keptTokens = 0;
    let anyKept = false;
    const parts = chunks.map((c, i) => {
      const s = settled[i];
      const r = s.status === "fulfilled" ? s.value : null;
      if (r && (r.compression_risk !== "high" || wouldTruncate)) {
        if (r.compressed_text?.trim()) anyKept = true;
        if (r.compression_risk === "high") lowConfidence = true;
        originalTokens += r.original_tokens || 0;
        keptTokens += r.kept_tokens || 0;
        return r.compressed_text ?? "";
      }
      const est = Math.round(c.length / 4);
      originalTokens += est;
      keptTokens += est;
      return c;
    });
    const out = parts.filter((p) => p.trim()).join("\n");
    if (!anyKept || out.length > text.length * 0.9) {
      const risky = settled.some((s) => s.status === "fulfilled" && s.value.compression_risk === "high");
      if (risky) this.app.store.log("system", `Kept the full ${o.toolName} result`, "SuperCompress wasn't confident the shortened version kept everything relevant.");
      return { text, note: null };
    }

    this.remember(o.resultId, text);
    this.record(originalTokens, keptTokens);
    const pct = Math.round((1 - keptTokens / Math.max(1, originalTokens)) * 100);
    const note =
      `[SuperCompress kept the parts relevant to the current request — ${keptTokens.toLocaleString()} of ${originalTokens.toLocaleString()} tokens (${pct}% smaller); kept lines are verbatim. ` +
      (lowConfidence ? "Its verifier was less sure than usual this time, but the full result was too long to show anyway. " : "") +
      `If something you need seems missing, call get_full_result with result_id "${o.resultId}".]`;
    return { text: out, note };
  }

  /** Raw API call; throws on any failure. Used directly by the settings "Test" button. */
  async call(context: string, query: string, signal?: AbortSignal, timeoutMs = BACKGROUND_TIMEOUT_MS): Promise<ApiResponse> {
    const key = this.key();
    if (!key) throw new Error("No SuperCompress API key. Add one in Settings → Models → Context compression.");
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({ context, query: query.slice(0, 4000) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeout(timeoutMs))]) : AbortSignal.timeout(this.timeout(timeoutMs)),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      if (res.status === 401) this.pause(60 * 60_000, "SuperCompress rejected the API key — check it in Settings → Models.");
      else if (res.status === 402) this.pause(60 * 60_000, "SuperCompress quota is used up — compression is paused for an hour.");
      else if (res.status === 429) this.pause(60_000, "SuperCompress rate limit — pausing for a minute.");
      if ([401, 402, 429].includes(res.status)) throw new PauseError(this.pauseReason ?? `HTTP ${res.status}`);
      throw new Error(`SuperCompress HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    const data = (await res.json()) as ApiResponse;
    if (typeof data.compressed_text !== "string") throw new Error("SuperCompress returned no compressed_text");
    return data;
  }

  private pause(ms: number, reason: string) {
    const wasPaused = Date.now() < this.pausedUntil;
    this.pausedUntil = Date.now() + ms;
    this.pauseReason = reason;
    if (!wasPaused) this.app.store.log("system", "Context compression paused", reason);
  }

  private remember(id: string, text: string) {
    this.originals.set(id, text);
    while (this.originals.size > KEEP_ORIGINALS) this.originals.delete(this.originals.keys().next().value!);
  }

  private stats(): CompressionStats {
    return this.app.kv.get<CompressionStats>("compression_stats", { days: {} });
  }

  private record(originalTokens: number, keptTokens: number) {
    const st = this.stats();
    const k = dayKey(Date.now());
    const d = (st.days[k] ??= { calls: 0, originalTokens: 0, keptTokens: 0 });
    d.calls += 1;
    d.originalTokens += originalTokens || 0;
    d.keptTokens += keptTokens || 0;
    const cutoff = dayKey(Date.now() - 60 * 86400_000);
    for (const key of Object.keys(st.days)) if (key < cutoff) delete st.days[key];
    this.app.kv.set("compression_stats", st);
  }
}

class PauseError extends Error {}

/** Split at line boundaries into pieces of at most `max` chars (a longer single line is hard-split). */
export function splitChunks(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    for (let i = 0; i < Math.max(1, line.length); i += max) {
      const piece = line.slice(i, i + max);
      if (cur && cur.length + 1 + piece.length > max) {
        out.push(cur);
        cur = piece;
      } else cur = cur ? `${cur}\n${piece}` : piece;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function dayKey(ts: number) {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Lossless escape hatch: the model can always get back what compression dropped. */
export const fullResultTool: Tool = {
  name: "get_full_result",
  description:
    "Fetch the complete, uncompressed text of a tool result that SuperCompress shortened. Use only when the compressed version is missing something you need.",
  parameters: obj({ result_id: str('The result_id from the "[SuperCompress kept…]" note, e.g. "res_abc123"') }),
  risk: "read",
  source: "builtin",
  compress: false,
  summarize: () => "Opened the full tool result",
  run: async (a, { app }) => {
    const text = app.compressor.original(String(a.result_id));
    if (text === null) return "That result is no longer available — call the original tool again.";
    return { text, untrusted: true };
  },
};
