import type { ModelRef, ToolCallView } from "../shared.ts";
import type { App } from "../app.ts";
import type { Block, Effort, LlmMessage, StopReason } from "../providers/types.ts";
import { textOf } from "../providers/types.ts";
import type { Tool, ToolContext } from "../tools/types.ts";
import { executeCall } from "./gate.ts";

export interface LoopOptions {
  app: App;
  channelId: string;
  taskId: string | null;
  background: boolean;
  models: ModelRef[];
  effort: Effort;
  system: { stable: string; volatile: string };
  /** Mutated in place, append-only (keeps provider reasoning valid within the run). */
  messages: LlmMessage[];
  tools: Tool[];
  signal: AbortSignal;
  maxSteps: number;
  onDelta?: (text: string) => void;
  onToolCalls?: (views: ToolCallView[]) => void;
  /** Called after each model step with that step's text and tool views. */
  onStep?: (step: { text: string; views: ToolCallView[]; model: ModelRef }) => void;
  /** Return a reason string to stop before the next model call (budgets). */
  shouldStop?: () => string | null;
}

export type LoopEnd = "done" | "max_steps" | "budget" | "stopped" | "ask_user" | "task_done" | "refused" | "error";

export interface LoopResult {
  text: string;
  /** Text of the final model step only. */
  lastText: string;
  views: ToolCallView[];
  artifactIds: string[];
  approvalIds: string[];
  steps: number;
  model: ModelRef | null;
  end: LoopEnd;
  stopReason?: StopReason;
  error?: string;
}

export async function runLoop(o: LoopOptions): Promise<LoopResult> {
  const toolMap = new Map(o.tools.map((t) => [t.name, t]));
  const specs = o.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  const ctx: ToolContext = { app: o.app, channelId: o.channelId, taskId: o.taskId, background: o.background, signal: o.signal };
  const res: LoopResult = { text: "", lastText: "", views: [], artifactIds: [], approvalIds: [], steps: 0, model: null, end: "done" };
  let sep = false;

  for (; res.steps < o.maxSteps; res.steps++) {
    if (o.signal.aborted) return { ...res, end: "stopped" };
    const why = o.shouldStop?.();
    if (why) return { ...res, end: "budget", error: why };

    let stepText = "";
    let reply;
    try {
      reply = await o.app.providers.chat(
        o.models,
        {
          system: o.system,
          messages: o.messages,
          tools: specs,
          effort: o.effort,
          signal: o.signal,
          onText: (d) => {
            if (sep && !stepText) {
              res.text += "\n\n";
              o.onDelta?.("\n\n");
            }
            stepText += d;
            res.text += d;
            o.onDelta?.(d);
          },
        },
        { background: o.background, taskId: o.taskId },
      );
    } catch (e) {
      if (o.signal.aborted) return { ...res, end: "stopped" };
      return { ...res, end: "error", error: e instanceof Error ? e.message : String(e) };
    }
    res.model = reply.model;
    res.stopReason = reply.stop;

    // Non-streaming adapters (or partial streams): make sure the text is accounted for.
    const full = textOf(reply.content);
    if (full && full !== stepText) {
      const extra = full.startsWith(stepText) ? full.slice(stepText.length) : stepText ? "" : full;
      if (extra) {
        res.text += extra;
        o.onDelta?.(extra);
        stepText += extra;
      }
    }
    if (stepText) {
      sep = true;
      res.lastText = stepText;
    }

    o.messages.push({ role: "assistant", content: reply.content });

    if (reply.stop === "refusal") {
      const note = `\n\n_(The model declined this request${reply.refusalNote ? `: ${reply.refusalNote}` : ""}.)_`;
      res.text += note;
      o.onDelta?.(note);
      o.onStep?.({ text: stepText + note, views: [], model: reply.model });
      return { ...res, end: "refused" };
    }

    const calls = reply.content.filter((b): b is Extract<Block, { type: "tool_call" }> => b.type === "tool_call");
    if (!calls.length) {
      o.onStep?.({ text: stepText, views: [], model: reply.model });
      if (reply.stop === "max_tokens") {
        // Ask the model to continue rather than ending mid-sentence.
        o.messages.push({ role: "user", content: [{ type: "text", text: "(Your reply was cut off by the length limit. Continue exactly where you stopped.)" }] });
        continue;
      }
      return { ...res, end: "done" };
    }
    if (reply.stop === "max_tokens") {
      // Tool input may be truncated; don't execute it.
      const results: Block[] = calls.map((c) => ({
        type: "tool_result",
        callId: c.id,
        name: c.name,
        content: "Not executed: your response hit the length limit while writing this call. Re-issue it (split large content across smaller calls).",
        isError: true,
      }));
      o.messages.push({ role: "user", content: results });
      continue;
    }

    // Show running chips immediately.
    const running: ToolCallView[] = calls.map((c) => {
      const t = toolMap.get(c.name);
      let summary = c.name;
      try {
        summary = t?.summarize?.(c.args ?? {}) ?? c.name;
      } catch {}
      return { id: c.id, name: c.name, summary, status: "running" };
    });
    o.onToolCalls?.([...res.views, ...running]);

    const outcomes = await Promise.all(calls.map((c) => executeCall(c, toolMap, ctx)));
    const stepViews = outcomes.map((x) => x.view);
    res.views.push(...stepViews);
    for (const x of outcomes) {
      res.artifactIds.push(...x.artifactIds);
      if (x.approvalId) res.approvalIds.push(x.approvalId);
    }
    o.onToolCalls?.(res.views);
    o.onStep?.({ text: stepText, views: stepViews, model: reply.model });
    // All results for one assistant turn go back in a single user message.
    o.messages.push({ role: "user", content: outcomes.map((x) => x.result) });

    const halt = outcomes.find((x) => x.halt)?.halt;
    if (halt) return { ...res, steps: res.steps + 1, end: halt };
  }
  return { ...res, end: "max_steps" };
}
