import type { ModelRef, ProviderConfig } from "../shared.ts";
import type { DB } from "../db.ts";
import { kvGet, kvSet } from "../db.ts";
import type { Vault } from "../vault/vault.ts";
import { AnthropicAdapter } from "./anthropic.ts";
import { GeminiAdapter } from "./gemini.ts";
import { OpenAIAdapter } from "./openai.ts";
import type { ChatRequest, ChatResponse, ProviderAdapter } from "./types.ts";
import { ProviderError } from "./types.ts";
import { sleep, zonedParts } from "../util.ts";

const p = (
  id: string,
  kind: ProviderConfig["kind"],
  label: string,
  baseUrl: string,
  apiKeySecret: string | null,
): ProviderConfig => ({ id, kind, label, baseUrl, apiKeySecret, enabled: false });

export const PROVIDER_PRESETS: ProviderConfig[] = [
  p("anthropic", "anthropic", "Anthropic", "https://api.anthropic.com", "ANTHROPIC_API_KEY"),
  p("openai", "openai", "OpenAI", "https://api.openai.com/v1", "OPENAI_API_KEY"),
  p("gemini", "gemini", "Google Gemini", "https://generativelanguage.googleapis.com/v1beta", "GEMINI_API_KEY"),
  p("openrouter", "openai", "OpenRouter", "https://openrouter.ai/api/v1", "OPENROUTER_API_KEY"),
  p("xai", "openai", "xAI", "https://api.x.ai/v1", "XAI_API_KEY"),
  p("mistral", "openai", "Mistral", "https://api.mistral.ai/v1", "MISTRAL_API_KEY"),
  p("deepseek", "openai", "DeepSeek", "https://api.deepseek.com/v1", "DEEPSEEK_API_KEY"),
  p("groq", "openai", "Groq", "https://api.groq.com/openai/v1", "GROQ_API_KEY"),
  p("together", "openai", "Together AI", "https://api.together.xyz/v1", "TOGETHER_API_KEY"),
  p("fireworks", "openai", "Fireworks", "https://api.fireworks.ai/inference/v1", "FIREWORKS_API_KEY"),
  p("cerebras", "openai", "Cerebras", "https://api.cerebras.ai/v1", "CEREBRAS_API_KEY"),
  p("moonshot", "openai", "Moonshot (Kimi)", "https://api.moonshot.ai/v1", "MOONSHOT_API_KEY"),
  p("azure", "openai", "Azure OpenAI (v1 API)", "https://YOUR-RESOURCE.openai.azure.com/openai/v1", "AZURE_OPENAI_API_KEY"),
  p("ollama", "openai", "Ollama (local)", "http://localhost:11434/v1", null),
  p("lmstudio", "openai", "LM Studio (local)", "http://localhost:1234/v1", null),
  p("custom", "openai", "Custom OpenAI-compatible", "http://localhost:8000/v1", "CUSTOM_API_KEY"),
];

const LOCAL = new Set(["ollama", "lmstudio"]);

/** USD per million tokens [input, output, cacheRead]. Matched by longest prefix of the model id. */
const DEFAULT_PRICING: Record<string, [number, number, number?]> = {
  "claude-fable-5-1": [10, 50, 0.25],
  "claude-fable-5": [10, 50, 1],
  "claude-opus-5-5": [4, 20, 0.2],
  "claude-opus-5": [5, 25, 0.5],
  "claude-opus-4": [5, 25, 0.5],
  "claude-sonnet-5-5": [2, 10, 0.2],
  "claude-sonnet-5": [2, 10, 0.2],
  "claude-sonnet-4": [3, 15, 0.3],
  "claude-haiku-5-5": [0.1, 0.5, 0.01],
  "claude-haiku-4": [1, 5, 0.1],
};
/** Conservative default for models without a known price (override in kv "pricing"). */
const UNKNOWN_RATE: [number, number] = [1, 5];

export function parseModelRef(ref: ModelRef): { providerId: string; model: string } {
  const i = ref.indexOf(":");
  if (i <= 0) throw new Error(`Invalid model "${ref}". Use provider:model, e.g. anthropic:claude-opus-5-5`);
  return { providerId: ref.slice(0, i), model: ref.slice(i + 1) };
}

export interface CallContext {
  background: boolean;
  taskId?: string | null;
}

export class Providers {
  private adapters = new Map<string, ProviderAdapter>();

  constructor(
    private db: DB,
    private vault: Vault,
    private timezone: () => string,
  ) {}

  list(): ProviderConfig[] {
    const saved = kvGet<Record<string, ProviderConfig>>(this.db, "providers", {});
    const merged = PROVIDER_PRESETS.map((preset) => {
      const s = saved[preset.id];
      if (s) return { ...preset, ...s };
      // auto-enable presets whose key is already present (e.g. via env)
      const enabled = preset.apiKeySecret ? this.vault.has(preset.apiKeySecret) : false;
      return { ...preset, enabled };
    });
    for (const s of Object.values(saved)) if (!merged.some((m) => m.id === s.id)) merged.push(s);
    return merged;
  }

  get(id: string): ProviderConfig | undefined {
    return this.list().find((p) => p.id === id);
  }

  save(cfg: ProviderConfig): ProviderConfig {
    if (!/^[a-z0-9_-]{1,40}$/.test(cfg.id)) throw new Error("Provider id must be lowercase letters, digits, _ or -");
    if (!["anthropic", "openai", "gemini"].includes(cfg.kind)) throw new Error("kind must be anthropic, openai or gemini");
    const saved = kvGet<Record<string, ProviderConfig>>(this.db, "providers", {});
    saved[cfg.id] = cfg;
    kvSet(this.db, "providers", saved);
    this.adapters.delete(cfg.id);
    return cfg;
  }

  remove(id: string) {
    const saved = kvGet<Record<string, ProviderConfig>>(this.db, "providers", {});
    delete saved[id];
    kvSet(this.db, "providers", saved);
    this.adapters.delete(id);
  }

  adapter(id: string): ProviderAdapter {
    const cached = this.adapters.get(id);
    if (cached) return cached;
    const cfg = this.get(id);
    if (!cfg) throw new Error(`Unknown provider "${id}"`);
    if (!cfg.enabled) throw new Error(`Provider "${cfg.label}" is disabled. Enable it in Settings → Providers.`);
    const key = cfg.apiKeySecret ? this.vault.get(cfg.apiKeySecret) : null;
    if (cfg.apiKeySecret && !key && !LOCAL.has(cfg.id)) {
      throw new Error(`No API key for ${cfg.label}. Add secret ${cfg.apiKeySecret} in Settings → Providers.`);
    }
    const headers = cfg.extraHeaders ? this.vault.resolveRecord(cfg.extraHeaders) : undefined;
    let a: ProviderAdapter;
    if (cfg.kind === "anthropic") a = new AnthropicAdapter({ apiKey: key ?? "", baseUrl: cfg.baseUrl, headers });
    else if (cfg.kind === "gemini") a = new GeminiAdapter({ apiKey: key ?? "", baseUrl: cfg.baseUrl });
    else a = new OpenAIAdapter({ id: cfg.id, apiKey: key, baseUrl: cfg.baseUrl, headers });
    this.adapters.set(id, a);
    return a;
  }

  invalidate() {
    this.adapters.clear();
  }

  /** USD estimate for a call. */
  price(ref: ModelRef, inTok: number, outTok: number, cacheRead = 0): number {
    const { providerId, model } = parseModelRef(ref);
    if (LOCAL.has(providerId)) return 0;
    const table = { ...DEFAULT_PRICING, ...kvGet<Record<string, [number, number, number?]>>(this.db, "pricing", {}) };
    const bare = model.replace(/^[^/]+\//, ""); // "anthropic/claude-…" on OpenRouter
    const key =
      Object.keys(table)
        .filter((k) => ref.startsWith(k) || model.startsWith(k) || bare.startsWith(k))
        .sort((a, b) => b.length - a.length)[0] ?? null;
    const [i, o, c] = key ? table[key] : UNKNOWN_RATE;
    const cr = c ?? i * 0.1;
    return (Math.max(0, inTok - cacheRead) * i + cacheRead * cr + outTok * o) / 1e6;
  }

  backgroundSpendToday(): number {
    const day = zonedParts(Date.now(), this.timezone()).date;
    const r = this.db.prepare("SELECT COALESCE(SUM(usd),0) AS s FROM usage WHERE day = ? AND background = 1").get(day) as { s: number };
    return r.s;
  }

  taskSpend(taskId: string): number {
    const r = this.db.prepare("SELECT COALESCE(SUM(usd),0) AS s FROM usage WHERE task_id = ?").get(taskId) as { s: number };
    return r.s;
  }

  /**
   * Call a model with retries and an ordered fallback chain across providers.
   * Records usage for cost tracking and budget enforcement.
   */
  async chat(refs: ModelRef[], req: Omit<ChatRequest, "model">, ctx: CallContext): Promise<ChatResponse & { model: ModelRef }> {
    const chain = [...new Set(refs.filter(Boolean))];
    if (!chain.length) throw new Error("No model configured. Pick one in Settings → Models.");
    let lastErr: unknown;
    for (const ref of chain) {
      let adapter: ProviderAdapter;
      let model: string;
      try {
        const parsed = parseModelRef(ref);
        model = parsed.model;
        adapter = this.adapter(parsed.providerId);
      } catch (e) {
        lastErr = e;
        continue;
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        let streamed = false;
        try {
          const res = await adapter.chat({
            ...req,
            model,
            onText: req.onText
              ? (d) => {
                  streamed = true;
                  req.onText!(d);
                }
              : undefined,
          });
          this.record(ref, res, ctx);
          // A refusal is final for this model; try the next model in the chain.
          if (res.stop === "refusal" && chain.indexOf(ref) < chain.length - 1) {
            lastErr = new Error(res.refusalNote ?? "refused");
            break;
          }
          return { ...res, model: ref };
        } catch (e) {
          lastErr = e;
          if (req.signal?.aborted) throw e;
          // Don't retry after partial output was streamed — the UI already showed it.
          if (!(e instanceof ProviderError) || !e.retryable || streamed) break;
          await sleep(1000 * 2 ** attempt + Math.random() * 500, req.signal);
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private record(ref: ModelRef, res: ChatResponse, ctx: CallContext) {
    const usd = res.usage.costUsd ?? this.price(ref, res.usage.inputTokens, res.usage.outputTokens, res.usage.cacheReadTokens ?? 0);
    const day = zonedParts(Date.now(), this.timezone()).date;
    this.db
      .prepare("INSERT INTO usage (at, day, model, input_tokens, output_tokens, usd, background, task_id) VALUES (?,?,?,?,?,?,?,?)")
      .run(Date.now(), day, ref, res.usage.inputTokens, res.usage.outputTokens, usd, ctx.background ? 1 : 0, ctx.taskId ?? null);
  }
}
