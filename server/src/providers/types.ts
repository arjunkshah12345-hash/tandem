// Provider-neutral conversation format. Every adapter converts to and from this.

export type Block =
  | { type: "text"; text: string; meta?: Record<string, unknown> }
  | { type: "image"; mediaType: string; data: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown>; meta?: Record<string, unknown> }
  | {
      type: "tool_result";
      callId: string;
      name: string;
      content: string;
      isError?: boolean;
      images?: { mediaType: string; data: string }[];
    }
  /**
   * Opaque provider reasoning (e.g. Anthropic thinking blocks). Replayed verbatim to the
   * same provider kind within a turn; dropped for other providers.
   */
  | { type: "reasoning"; provider: string; raw: unknown };

export interface LlmMessage {
  role: "user" | "assistant";
  content: Block[];
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema (object). */
  parameters: Record<string, unknown>;
}

export type Effort = "low" | "medium" | "high";

export interface ChatRequest {
  model: string;
  /** Stable system text (cache-friendly), followed by volatile context. */
  system: { stable: string; volatile?: string };
  messages: LlmMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  effort?: Effort;
  /** Ask for a JSON object response (best-effort per provider). */
  json?: boolean;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
}

export type StopReason = "end" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Provider-reported cost in USD when available (e.g. OpenRouter). */
  costUsd?: number;
}

export interface ChatResponse {
  content: Block[];
  stop: StopReason;
  usage: Usage;
  /** Model that actually served the request (may differ under fallbacks). */
  servedBy?: string;
  refusalNote?: string;
}

export interface ProviderAdapter {
  chat(req: ChatRequest): Promise<ChatResponse>;
  listModels(): Promise<string[]>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public status: number | null,
    public retryable: boolean,
  ) {
    super(message);
  }
}

export function textOf(blocks: Block[]): string {
  return blocks
    .filter((b): b is Extract<Block, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}
