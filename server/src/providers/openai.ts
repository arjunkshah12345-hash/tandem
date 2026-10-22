import type { Block, ChatRequest, ChatResponse, LlmMessage, ProviderAdapter, StopReason } from "./types.ts";
import { ProviderError } from "./types.ts";
import { getJson, postSse } from "./sse.ts";

/**
 * OpenAI Chat Completions wire protocol. Covers OpenAI itself plus every compatible
 * endpoint: OpenRouter, Groq, Together, DeepSeek, Mistral, xAI, Fireworks, Cerebras,
 * Ollama, LM Studio, vLLM, llama.cpp, Azure (v1 API), and so on.
 */
export class OpenAIAdapter implements ProviderAdapter {
  constructor(
    private opts: {
      id: string;
      apiKey: string | null;
      baseUrl: string;
      headers?: Record<string, string>;
    },
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { ...(this.opts.headers ?? {}) };
    if (this.opts.apiKey) h.authorization = `Bearer ${this.opts.apiKey}`;
    if (this.opts.id === "openrouter") {
      h["HTTP-Referer"] = "https://github.com/tandem-agent/tandem";
      h["X-Title"] = "Tandem";
    }
    return h;
  }

  private url(path: string) {
    return this.opts.baseUrl.replace(/\/+$/, "") + path;
  }

  async listModels(): Promise<string[]> {
    const j = await getJson(this.url("/models"), this.headers(), this.opts.id);
    return ((j.data ?? j.models ?? []) as any[]).map((m) => m.id ?? m.name).filter(Boolean).sort();
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const isOpenAI = this.opts.id === "openai" || this.opts.id === "azure";
    const system = [req.system.stable, req.system.volatile].filter(Boolean).join("\n\n");
    const body: Record<string, unknown> = {
      model: req.model,
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: isOpenAI ? "developer" : "system", content: system }, ...toOpenAI(req.messages)],
    };
    const max = req.maxTokens ?? 16000;
    if (isOpenAI) body.max_completion_tokens = max;
    else body.max_tokens = max;
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    if (req.json) body.response_format = { type: "json_object" };
    if (isOpenAI && req.effort && /^(o\d|gpt-5|gpt-6)/.test(req.model)) body.reasoning_effort = req.effort;
    if (this.opts.id === "openrouter") body.usage = { include: true };

    let text = "";
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let finish: string | null = null;
    const usage = { inputTokens: 0, outputTokens: 0, costUsd: undefined as number | undefined, cacheReadTokens: 0 };
    let servedBy: string | undefined;

    for await (const data of postSse(this.url("/chat/completions"), body, this.headers(), req.signal, this.opts.id)) {
      if (data === "[DONE]") break;
      let chunk: any;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk.error) throw new ProviderError(`${this.opts.id}: ${chunk.error.message ?? JSON.stringify(chunk.error)}`, null, true);
      servedBy ??= chunk.model;
      if (chunk.usage) {
        usage.inputTokens = chunk.usage.prompt_tokens ?? usage.inputTokens;
        usage.outputTokens = chunk.usage.completion_tokens ?? usage.outputTokens;
        usage.cacheReadTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
        if (typeof chunk.usage.cost === "number") usage.costUsd = chunk.usage.cost;
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const d = choice.delta ?? {};
      if (typeof d.content === "string" && d.content) {
        text += d.content;
        req.onText?.(d.content);
      }
      for (const tc of d.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const cur = calls.get(idx) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(idx, cur);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }

    const content: Block[] = [];
    if (text) content.push({ type: "text", text });
    for (const [i, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      let args: Record<string, unknown> = {};
      try {
        args = c.args ? JSON.parse(c.args) : {};
      } catch {
        args = { INVALID_JSON: c.args };
      }
      content.push({ type: "tool_call", id: c.id || `call_${i}_${Date.now()}`, name: c.name, args });
    }
    const stop: StopReason =
      calls.size > 0
        ? "tool_use"
        : finish === "length"
          ? "max_tokens"
          : finish === "content_filter"
            ? "refusal"
            : finish === "stop" || finish === null
              ? "end"
              : "other";
    return { content, stop, usage, servedBy };
  }
}

function toOpenAI(messages: LlmMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.content.filter((b) => b.type === "text").map((b) => (b as any).text).join("");
      const calls = m.content.filter((b): b is Extract<Block, { type: "tool_call" }> => b.type === "tool_call");
      out.push({
        role: "assistant",
        content: text || null,
        ...(calls.length
          ? {
              tool_calls: calls.map((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: JSON.stringify(c.args) },
              })),
            }
          : {}),
      });
      continue;
    }
    // user turn: tool results become role=tool messages, the rest a user message
    const results = m.content.filter((b): b is Extract<Block, { type: "tool_result" }> => b.type === "tool_result");
    const followUpImages: unknown[] = [];
    for (const r of results) {
      out.push({ role: "tool", tool_call_id: r.callId, content: r.isError ? `ERROR: ${r.content}` : r.content });
      for (const img of r.images ?? []) {
        followUpImages.push({ type: "image_url", image_url: { url: `data:${img.mediaType};base64,${img.data}` } });
      }
    }
    const parts: unknown[] = [];
    for (const b of m.content) {
      if (b.type === "text" && b.text) parts.push({ type: "text", text: b.text });
      if (b.type === "image") parts.push({ type: "image_url", image_url: { url: `data:${b.mediaType};base64,${b.data}` } });
    }
    if (followUpImages.length) parts.push({ type: "text", text: "(Images returned by the tool above.)" }, ...followUpImages);
    if (parts.length) {
      const onlyText = parts.every((p: any) => p.type === "text");
      out.push({ role: "user", content: onlyText ? parts.map((p: any) => p.text).join("\n\n") : parts });
    }
  }
  return out;
}
