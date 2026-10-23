import type { App } from "../app.ts";
import type { Message, MessageKind } from "../shared.ts";
import { bus } from "../bus.ts";
import type { LlmMessage } from "../providers/types.ts";
import { channelHistory, maybeCompact } from "./context.ts";
import { runLoop, type LoopResult } from "./loop.ts";
import { stableSystem, volatileSystem, type Mode } from "./prompt.ts";
import { errorMessage } from "../util.ts";

interface TurnOpts {
  mode: Mode;
  /** Instruction appended after the history but not shown in the thread (scheduled jobs). */
  hiddenPrompt?: string;
  kind?: MessageKind;
  background?: boolean;
  /** Skip posting a message; caller handles output (check-ins). */
  silent?: boolean;
  maxSteps?: number;
  typingLabel?: string;
}

/** Runs conversational turns per channel: one at a time, with queued follow-ups and stop. */
export class Agent {
  private active = new Map<string, { abort: AbortController; promise: Promise<unknown> }>();
  private queued = new Set<string>();

  constructor(private app: App) {}

  isBusy(channelId: string) {
    return this.active.has(channelId);
  }

  async userMessage(channelId: string, content: string, _meta: { via?: string } = {}): Promise<Message> {
    if (!this.app.store.getChannel(channelId)) throw new Error("channel not found");
    const msg = this.app.store.addMessage({ channelId, role: "user", content });
    this.app.store.markRead(channelId);
    if (this.active.has(channelId)) {
      // The user is steering mid-turn; run again right after with the new message in context.
      this.queued.add(channelId);
    } else {
      void this.turn(channelId, { mode: "chat" });
    }
    return msg;
  }

  stop(channelId: string) {
    this.queued.delete(channelId);
    this.active.get(channelId)?.abort.abort();
  }

  stopAll() {
    for (const a of this.active.values()) a.abort.abort();
  }

  /** Run one agent turn in a channel. Waits for any in-flight turn there first. */
  async turn(channelId: string, o: TurnOpts): Promise<LoopResult | null> {
    while (this.active.has(channelId)) await this.active.get(channelId)!.promise.catch(() => {});
    const abort = new AbortController();
    const promise = this.doTurn(channelId, o, abort);
    this.active.set(channelId, { abort, promise });
    try {
      return await promise;
    } finally {
      this.active.delete(channelId);
      bus.emitEvent({ type: "typing", channelId, active: false });
      if (this.queued.delete(channelId)) void this.turn(channelId, { mode: "chat" });
    }
  }

  private async doTurn(channelId: string, o: TurnOpts, abort: AbortController): Promise<LoopResult | null> {
    const { app } = this;
    const s = app.settings.get();
    await maybeCompact(app, channelId);

    const history: LlmMessage[] = channelHistory(app, channelId);
    if (o.hiddenPrompt) {
      const last = history[history.length - 1];
      if (last?.role === "user") last.content.push({ type: "text", text: o.hiddenPrompt });
      else history.push({ role: "user", content: [{ type: "text", text: o.hiddenPrompt }] });
    }
    if (!history.length) return null;
    const lastUser = [...history].reverse().find((m) => m.role === "user");
    const query = lastUser?.content.map((b) => (b.type === "text" ? b.text : "")).join(" ").slice(-2000) ?? "";

    bus.emitEvent({ type: "typing", channelId, active: true, label: o.typingLabel });
    const placeholder = o.silent
      ? null
      : app.store.addMessage({ channelId, role: "assistant", kind: o.kind ?? "chat", content: "", model: s.models.work });

    const models = o.mode === "checkin" ? [s.models.triage, s.models.work, ...s.models.fallbacks] : [s.models.work, ...s.models.fallbacks];
    let buffered = "";
    let flush: NodeJS.Timeout | null = null;
    const result = await runLoop({
      app,
      channelId,
      taskId: null,
      background: !!o.background,
      models,
      effort: o.mode === "checkin" ? "low" : o.mode === "chat" ? "medium" : "medium",
      system: { stable: stableSystem(), volatile: volatileSystem(app, { mode: o.mode, channelId, query }) },
      query,
      messages: history,
      tools: app.tools({ task: false }),
      signal: abort.signal,
      maxSteps: o.maxSteps ?? 40,
      onDelta: placeholder
        ? (d) => {
            // Coalesce tiny deltas into ~30ms frames.
            buffered += d;
            flush ??= setTimeout(() => {
              bus.emitEvent({ type: "message_delta", messageId: placeholder.id, channelId, delta: buffered });
              buffered = "";
              flush = null;
            }, 30);
          }
        : undefined,
      onToolCalls: placeholder ? (views) => app.store.updateMessage(placeholder.id, { toolCalls: views }) : undefined,
      shouldStop: o.background ? () => app.budget.backgroundBlocked() : undefined,
    });
    if (flush) {
      clearTimeout(flush);
      bus.emitEvent({ type: "message_delta", messageId: placeholder!.id, channelId, delta: buffered });
    }

    let content = result.text.trim();
    if (result.end === "stopped") content += content ? "\n\n_(stopped)_" : "_(stopped)_";
    if (result.end === "error") {
      app.store.log("error", "Agent turn failed", result.error ?? null, channelId);
      content += `${content ? "\n\n" : ""}⚠️ I couldn't finish: ${result.error}`;
    }
    if (result.end === "budget") content += `${content ? "\n\n" : ""}_Paused: ${result.error}_`;
    if (result.end === "max_steps") content += "\n\n_(I hit my step limit for one turn — say “continue” and I'll pick up from here.)_";

    if (placeholder) {
      if (!content && !result.views.length) {
        app.store.updateMessage(placeholder.id, { content: "_(no reply)_" });
      } else {
        app.store.updateMessage(placeholder.id, {
          content,
          toolCalls: result.views,
          artifactIds: [...new Set(result.artifactIds)],
          model: result.model,
        });
      }
    }
    return result;
  }

  /** A scheduled job that posts its result in a channel (brief, routine). */
  async scheduled(channelId: string, mode: Mode, prompt: string, kind: MessageKind, label: string) {
    try {
      return await this.turn(channelId, { mode, hiddenPrompt: prompt, kind, background: true, typingLabel: label });
    } catch (e) {
      this.app.store.log("error", `${label} failed`, errorMessage(e), channelId);
      return null;
    }
  }
}
