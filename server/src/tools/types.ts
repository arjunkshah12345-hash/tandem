import type { RiskLevel } from "../shared.ts";
import type { App } from "../app.ts";

export interface ToolContext {
  app: App;
  channelId: string;
  taskId: string | null;
  background: boolean;
  signal: AbortSignal;
}

export interface ToolOutput {
  text: string;
  images?: { mediaType: string; data: string }[];
  artifactIds?: string[];
  /** Text came from outside (email, web page, connector) and must be treated as data, not instructions. */
  untrusted?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Static risk, or computed from arguments (e.g. browser click on a "Pay" button). */
  risk: RiskLevel | ((args: Record<string, unknown>) => RiskLevel);
  /** "builtin", "builtin:task" (only inside background tasks), or the connector id. */
  source: string;
  /** One-line human summary for chips and the activity log. */
  summarize?(args: Record<string, unknown>): string;
  /** Plain-language title + payload preview for approval cards. */
  describe?(args: Record<string, unknown>): { title: string; preview: string };
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput | string>;
}

/** Tiny helpers for writing JSON schemas compactly. */
export function obj(properties: Record<string, unknown>, required: string[] = Object.keys(properties)): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}
export const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });
export const num = (description: string) => ({ type: "number", description });
export const bool = (description: string) => ({ type: "boolean", description });
export const arr = (items: unknown, description: string) => ({ type: "array", items, description });

/** Validate required keys and primitive types. Returns an error string or null. */
export function validateArgs(schema: Record<string, unknown>, args: Record<string, unknown>): string | null {
  if (!args || typeof args !== "object") return "Arguments must be a JSON object.";
  if ("INVALID_JSON" in args) return "Arguments were not valid JSON. Re-issue the call.";
  const props = (schema.properties ?? {}) as Record<string, any>;
  for (const k of (schema.required as string[]) ?? []) {
    if (args[k] === undefined || args[k] === null) return `Missing required argument "${k}".`;
  }
  for (const [k, v] of Object.entries(args)) {
    const t = props[k]?.type;
    if (!t || v === null || v === undefined) continue;
    const ok =
      Array.isArray(t) ||
      (t === "string" && typeof v === "string") ||
      (t === "number" && typeof v === "number") ||
      (t === "integer" && Number.isInteger(v)) ||
      (t === "boolean" && typeof v === "boolean") ||
      (t === "array" && Array.isArray(v)) ||
      (t === "object" && typeof v === "object" && !Array.isArray(v));
    if (!ok) return `Argument "${k}" should be ${t}.`;
    if (props[k]?.enum && !props[k].enum.includes(v)) return `Argument "${k}" must be one of ${props[k].enum.join(", ")}.`;
  }
  return null;
}
