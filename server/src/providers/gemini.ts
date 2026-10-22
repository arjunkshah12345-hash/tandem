import type { Block, ChatRequest, ChatResponse, LlmMessage, ProviderAdapter, StopReason } from "./types.ts";
import { ProviderError } from "./types.ts";
import { getJson, postSse } from "./sse.ts";

/** Google Gemini (Generative Language API) native protocol. */
export class GeminiAdapter implements ProviderAdapter {
  constructor(private opts: { apiKey: string; baseUrl: string }) {}

  private base() {
    return this.opts.baseUrl.replace(/\/+$/, "");
  }

  async listModels(): Promise<string[]> {
    const j = await getJson(`${this.base()}/models?pageSize=200`, { "x-goog-api-key": this.opts.apiKey }, "gemini");
    return ((j.models ?? []) as any[])
      .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
      .map((m) => String(m.name).replace(/^models\//, ""))
      .sort();
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const genConfig: Record<string, unknown> = {
      maxOutputTokens: req.maxTokens ?? 16000,
      ...(req.json && !req.tools?.length ? { responseMimeType: "application/json" } : {}),
      ...(req.effort ? { thinkingConfig: { thinkingLevel: req.effort === "medium" ? "high" : req.effort } } : {}),
    };
    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: [req.system.stable, req.system.volatile].filter(Boolean).join("\n\n") }] },
      contents: toGemini(req.messages),
      generationConfig: genConfig,
    };
    if (req.tools?.length) {
      body.tools = [
        {
          functionDeclarations: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parametersJsonSchema: t.parameters,
          })),
        },
      ];
    }
    const url = `${this.base()}/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`;
    let content: Block[] = [];
    let finish: string | null = null;
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    let blocked: string | null = null;
    let n = 0;

    const run = async () => {
      content = [];
      for await (const data of postSse(url, body, { "x-goog-api-key": this.opts.apiKey }, req.signal, "gemini")) {
        const chunk = JSON.parse(data);
        if (chunk.promptFeedback?.blockReason) blocked = chunk.promptFeedback.blockReason;
        if (chunk.usageMetadata) {
          usage.inputTokens = chunk.usageMetadata.promptTokenCount ?? usage.inputTokens;
          usage.outputTokens = (chunk.usageMetadata.candidatesTokenCount ?? 0) + (chunk.usageMetadata.thoughtsTokenCount ?? 0);
          usage.cacheReadTokens = chunk.usageMetadata.cachedContentTokenCount ?? 0;
        }
        const cand = chunk.candidates?.[0];
        if (!cand) continue;
        if (cand.finishReason) finish = cand.finishReason;
        for (const p of cand.content?.parts ?? []) {
          if (p.thought) continue;
          // Gemini 3 requires thought signatures to be returned with the parts that carried them.
          const meta = p.thoughtSignature ? { thoughtSignature: p.thoughtSignature } : undefined;
          if (typeof p.text === "string") {
            req.onText?.(p.text);
            const last = content[content.length - 1];
            if (last?.type === "text" && !meta) last.text += p.text;
            else content.push({ type: "text", text: p.text, meta });
          } else if (p.functionCall) {
            content.push({
              type: "tool_call",
              id: p.functionCall.id ?? `gem_${Date.now()}_${n++}`,
              name: p.functionCall.name,
              args: p.functionCall.args ?? {},
              meta,
            });
          }
        }
      }
    };

    try {
      await run();
    } catch (e) {
      // Older Gemini models reject thinkingLevel; retry once without it.
      if (e instanceof ProviderError && e.status === 400 && /thinking/i.test(e.message)) {
        delete genConfig.thinkingConfig;
        await run();
      } else throw e;
    }

    const hasCalls = content.some((b) => b.type === "tool_call");
    const stop: StopReason = hasCalls
      ? "tool_use"
      : blocked || finish === "SAFETY" || finish === "PROHIBITED_CONTENT"
        ? "refusal"
        : finish === "MAX_TOKENS"
          ? "max_tokens"
          : finish === "STOP" || finish === null
            ? "end"
            : "other";
    return { content, stop, usage, refusalNote: blocked ?? undefined };
  }
}

function toGemini(messages: LlmMessage[]): unknown[] {
  return messages
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: m.content.flatMap((b): unknown[] => {
        switch (b.type) {
          case "text":
            return b.text ? [{ text: b.text, ...(b.meta?.thoughtSignature ? { thoughtSignature: b.meta.thoughtSignature } : {}) }] : [];
          case "image":
            return [{ inlineData: { mimeType: b.mediaType, data: b.data } }];
          case "tool_call":
            return [
              {
                functionCall: { name: b.name, args: b.args, ...(b.id.startsWith("gem_") ? {} : { id: b.id }) },
                ...(b.meta?.thoughtSignature ? { thoughtSignature: b.meta.thoughtSignature } : {}),
              },
            ];
          case "tool_result":
            return [
              {
                functionResponse: {
                  name: b.name,
                  ...(b.callId.startsWith("gem_") ? {} : { id: b.callId }),
                  response: b.isError ? { error: b.content } : { result: b.content },
                },
              },
              ...(b.images ?? []).map((i) => ({ inlineData: { mimeType: i.mediaType, data: i.data } })),
            ];
          case "reasoning":
            return [];
        }
      }),
    }))
    .filter((c) => c.parts.length);
}
