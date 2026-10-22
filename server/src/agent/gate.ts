import type { RiskLevel, ToolCallView } from "../shared.ts";
import type { Block } from "../providers/types.ts";
import type { Tool, ToolContext, ToolOutput } from "../tools/types.ts";
import { validateArgs } from "../tools/types.ts";
import { forbiddenByArgs } from "../policy/risk.ts";
import { redact, scanSensitive } from "../policy/sensitive.ts";
import { errorMessage, truncate } from "../util.ts";

export interface CallOutcome {
  result: Extract<Block, { type: "tool_result" }>;
  view: ToolCallView;
  artifactIds: string[];
  /** Stop the loop after this round (task_ask_user / task_done). */
  halt?: "ask_user" | "task_done";
  approvalId?: string;
}

const MAX_RESULT_CHARS = 50_000;

export function riskOf(tool: Tool, args: Record<string, unknown>): RiskLevel {
  return typeof tool.risk === "function" ? tool.risk(args) : tool.risk;
}

/**
 * The single choke point for every tool call the model makes:
 * validate → hard limits → sensitive-data scan → approval gate → execute → scrub output.
 */
export async function executeCall(
  call: Extract<Block, { type: "tool_call" }>,
  tools: Map<string, Tool>,
  ctx: ToolContext,
): Promise<CallOutcome> {
  const { app } = ctx;
  const tool = tools.get(call.name);
  const fail = (text: string, status: ToolCallView["status"] = "error", summary?: string): CallOutcome => ({
    result: { type: "tool_result", callId: call.id, name: call.name, content: text, isError: true },
    view: { id: call.id, name: call.name, summary: summary ?? call.name, status },
    artifactIds: [],
  });
  if (!tool) return fail(`Unknown tool "${call.name}".`);

  const args = call.args ?? {};
  const invalid = validateArgs(tool.parameters, args);
  const summary = safeSummary(tool, args);
  if (invalid) return fail(invalid, "error", summary);

  const risk = riskOf(tool, args);
  const settings = app.settings.get();

  // 1. Hard limits — never allowed, approval or not.
  const forbiddenReason = risk === "forbidden" ? `"${tool.name}" is on Tandem's off-limits list.` : riskIsOutbound(risk) ? forbiddenByArgs(tool.name, args) : null;
  if (forbiddenReason) {
    app.store.log("tool", `Blocked: ${summary}`, forbiddenReason, ctx.channelId, ctx.taskId);
    return fail(`BLOCKED: ${forbiddenReason} Explain this to the user; do not try another way.`, "blocked", summary);
  }

  // 2. Outbound data-loss prevention.
  if (riskIsOutbound(risk) && settings.safety.blockSensitiveData && tool.name !== "browser_fill_secret") {
    const findings = scanSensitive(JSON.stringify(args));
    if (findings.length) {
      const kinds = [...new Set(findings.map((f) => f.label))].join(", ");
      app.store.log("tool", `Blocked sensitive data: ${summary}`, kinds, ctx.channelId, ctx.taskId);
      return fail(
        `BLOCKED: the payload contains a ${kinds}. Tandem never sends these on the user's behalf. Remove it (e.g. "I'll share that separately") or tell the user to send it themselves.`,
        "blocked",
        summary,
      );
    }
  }

  // 3. Payment ceiling.
  if (risk === "payment") {
    const amt = paymentAmount(args);
    if (amt !== null && amt > settings.safety.maxPaymentUsd) {
      return fail(
        `BLOCKED: $${amt.toFixed(2)} exceeds the user's per-payment limit of $${settings.safety.maxPaymentUsd}. Tell the user; they can raise it in Settings → Safety.`,
        "blocked",
        summary,
      );
    }
  }

  // 4. Approval gate.
  if (settings.safety.approvalRequired.includes(risk)) {
    const existing = app.store
      .listApprovals("pending")
      .find((a) => a.toolName === tool.name && JSON.stringify(a.args) === JSON.stringify(args));
    if (existing) {
      return {
        result: { type: "tool_result", callId: call.id, name: call.name, content: `Already waiting for the user's approval (${existing.id}). Don't queue it again.` },
        view: { id: call.id, name: call.name, summary, status: "pending_approval" },
        artifactIds: [],
        approvalId: existing.id,
      };
    }
    const d = tool.describe?.(args) ?? { title: summary, preview: JSON.stringify(args, null, 2) };
    const warnings: string[] = [];
    if (settings.safety.actionReviewer) {
      const concern = await app.reviewer.review(tool, args, ctx).catch(() => null);
      if (concern) warnings.push(concern);
    }
    const ap = app.approvals.request({
      channelId: ctx.channelId,
      taskId: ctx.taskId,
      toolName: tool.name,
      risk,
      title: d.title,
      preview: redact(d.preview, app.vault.allValues()),
      args,
      warnings,
      toolCallId: call.id,
    });
    app.store.log("approval", `Asked approval: ${d.title}`, null, ctx.channelId, ctx.taskId);
    return {
      result: {
        type: "tool_result",
        callId: call.id,
        name: call.name,
        content: `Queued for the user's approval (${ap.id}) — they see an approval card with Approve / Not now. It has NOT happened yet. Don't ask about it in text. Continue with anything that doesn't depend on it; you'll be told the outcome.`,
      },
      view: { id: call.id, name: call.name, summary, status: "pending_approval" },
      artifactIds: [],
      approvalId: ap.id,
    };
  }

  // 5. Execute.
  return runTool(tool, args, ctx, call.id, summary);
}

export async function runTool(tool: Tool, args: Record<string, unknown>, ctx: ToolContext, callId: string, summary = safeSummary(tool, args)): Promise<CallOutcome> {
  const { app } = ctx;
  try {
    const raw = await tool.run(args, ctx);
    const out: ToolOutput = typeof raw === "string" ? { text: raw } : raw;
    let text = redact(truncate(out.text ?? "", MAX_RESULT_CHARS), app.vault.allValues());
    if (out.untrusted) {
      text = `<untrusted_content source="${tool.name}">\n${text.replace(/<\/?untrusted_content[^>]*>/g, "")}\n</untrusted_content>`;
    }
    if (riskOf(tool, args) !== "read") app.store.log("tool", summary, truncate(text, 400), ctx.channelId, ctx.taskId);
    const halt = tool.name === "task_ask_user" ? "ask_user" : tool.name === "task_done" ? "task_done" : undefined;
    return {
      result: { type: "tool_result", callId, name: tool.name, content: text, images: out.images },
      view: { id: callId, name: tool.name, summary, status: "ok" },
      artifactIds: out.artifactIds ?? [],
      halt,
    };
  } catch (e) {
    const msg = redact(errorMessage(e), app.vault.allValues());
    app.store.log("error", `Tool failed: ${summary}`, msg, ctx.channelId, ctx.taskId);
    return {
      result: { type: "tool_result", callId, name: tool.name, content: `Error: ${msg}`, isError: true },
      view: { id: callId, name: tool.name, summary, status: "error" },
      artifactIds: [],
    };
  }
}

function riskIsOutbound(r: RiskLevel) {
  return r === "external" || r === "payment" || r === "sign" || r === "delete";
}

function safeSummary(tool: Tool, args: Record<string, unknown>): string {
  try {
    return tool.summarize?.(args) ?? tool.name;
  } catch {
    return tool.name;
  }
}

/** Best-effort USD amount from common argument names (keys mentioning cents are divided by 100). */
export function paymentAmount(args: Record<string, unknown>): number | null {
  let best: number | null = null;
  const visit = (o: unknown, depth: number) => {
    if (!o || typeof o !== "object" || depth > 3) return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      const key = k.toLowerCase();
      if (typeof v === "number" || (typeof v === "string" && /^\$?\d+(\.\d+)?$/.test(v))) {
        const n = typeof v === "number" ? v : Number(v.replace("$", ""));
        let usd: number | null = null;
        if (/cents|amount_in_cents|unit_amount/.test(key)) usd = n / 100;
        // Ambiguous units are read as dollars: over-blocking is the safe failure.
        else if (/^(amount|total|price|max_?amount|spend|value)(_usd|_dollars)?$/.test(key)) usd = n;
        if (usd !== null) best = Math.max(best ?? 0, usd);
      } else visit(v, depth + 1);
    }
  };
  visit(args, 0);
  return best;
}
