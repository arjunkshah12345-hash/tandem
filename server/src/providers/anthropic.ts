import Anthropic from "@anthropic-ai/sdk";
import type { Block, ChatRequest, ChatResponse, LlmMessage, ProviderAdapter, StopReason } from "./types.ts";
import { ProviderError } from "./types.ts";

/** Models that take adaptive thinking + output_config.effort (Claude 4.6 and later). */
const ADAPTIVE = /claude-(opus|sonnet|haiku|fable|mythos)-(4-[6-9]|[5-9])/;
/** Models that accept server-side refusal fallbacks in the "default" form. */
const FALLBACK_DEFAULT = /claude-(fable-5-1|opus-5-5|opus-5$|sonnet-5-5)/;

export class AnthropicAdapter implements ProviderAdapter {
  private client: Anthropic;
  private firstParty: boolean;

  constructor(opts: { apiKey: string; baseUrl?: string; headers?: Record<string, string> }) {
    this.firstParty = !opts.baseUrl || opts.baseUrl.includes("api.anthropic.com");
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      baseURL: opts.baseUrl || undefined,
      defaultHeaders: opts.headers,
      maxRetries: 2,
    });
  }

  async listModels(): Promise<string[]> {
    const out: string[] = [];
    for await (const m of this.client.models.list()) out.push(m.id);
    return out;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const adaptive = ADAPTIVE.test(req.model);
    const betas: string[] = [];
    const system: object[] = [
      { type: "text", text: req.system.stable, cache_control: { type: "ephemeral" } },
      ...(req.system.volatile ? [{ type: "text", text: req.system.volatile }] : []),
    ];
    if (req.json) system.push({ type: "text", text: "Respond with a single JSON object and nothing else." });
    const params: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? 32000,
      system,
      messages: toAnthropic(req.messages),
    };
    if (req.tools?.length) {
      params.tools = req.tools.map((t, i) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
        eager_input_streaming: true,
        // cache the tool-list prefix
        ...(i === req.tools!.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
      }));
    }
    if (adaptive) {
      params.thinking = { type: "adaptive" };
      params.output_config = { effort: req.effort ?? "medium" };
    }
    if (this.firstParty && FALLBACK_DEFAULT.test(req.model)) {
      betas.push("server-side-fallback-2026-07-01");
      params.fallbacks = "default";
    }
    if (betas.length) params.betas = betas;

    let final: Anthropic.Beta.BetaMessage;
    try {
      const stream = this.client.beta.messages.stream(params as any, { signal: req.signal });
      if (req.onText) stream.on("text", (d) => req.onText!(d));
      final = await stream.finalMessage();
    } catch (e) {
      throw wrap(e);
    }

    const content: Block[] = [];
    for (const b of final.content as any[]) {
      if (b.type === "text") content.push({ type: "text", text: b.text });
      else if (b.type === "tool_use") {
        content.push({ type: "tool_call", id: b.id, name: b.name, args: (b.input ?? {}) as Record<string, unknown> });
      } else if (b.type === "thinking" || b.type === "redacted_thinking") {
        // Keep position: replayed verbatim inside the same turn (preserved thinking).
        content.push({ type: "reasoning", provider: "anthropic", raw: b });
      }
      // other block types (fallback markers, …) are informational only
    }

    const stop: StopReason =
      final.stop_reason === "end_turn" || final.stop_reason === "stop_sequence"
        ? "end"
        : final.stop_reason === "tool_use"
          ? "tool_use"
          : final.stop_reason === "max_tokens"
            ? "max_tokens"
            : final.stop_reason === "refusal"
              ? "refusal"
              : "other";

    const u = final.usage as any;
    return {
      content,
      stop,
      servedBy: final.model,
      refusalNote: stop === "refusal" ? ((final as any).stop_details?.explanation ?? "The model declined.") : undefined,
      usage: {
        inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      },
    };
  }
}

function toAnthropic(messages: LlmMessage[]): unknown[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content.flatMap((b): unknown[] => {
      switch (b.type) {
        case "text":
          return b.text ? [{ type: "text", text: b.text }] : [];
        case "image":
          return [{ type: "image", source: { type: "base64", media_type: b.mediaType, data: b.data } }];
        case "tool_call":
          return [{ type: "tool_use", id: b.id, name: b.name, input: b.args }];
        case "tool_result":
          return [
            {
              type: "tool_result",
              tool_use_id: b.callId,
              is_error: b.isError || undefined,
              content: [
                { type: "text", text: b.content || "(empty)" },
                ...(b.images ?? []).map((i) => ({
                  type: "image",
                  source: { type: "base64", media_type: i.mediaType, data: i.data },
                })),
              ],
            },
          ];
        case "reasoning":
          return b.provider === "anthropic" ? [b.raw] : [];
      }
    }),
  }));
}

function wrap(e: unknown): ProviderError {
  if (e instanceof Anthropic.APIError) {
    const status = e.status ?? null;
    const retryable = status === null || status === 429 || status === 408 || status === 409 || status >= 500;
    return new ProviderError(`Anthropic ${status ?? ""}: ${e.message}`, status, retryable);
  }
  if (e instanceof Error && (e.name === "AbortError" || e.message.includes("aborted"))) {
    return new ProviderError("aborted", null, false);
  }
  return new ProviderError(e instanceof Error ? e.message : String(e), null, true);
}
