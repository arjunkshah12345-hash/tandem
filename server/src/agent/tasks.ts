import type { App } from "../app.ts";
import type { Task } from "../shared.ts";
import type { LlmMessage } from "../providers/types.ts";
import { runLoop } from "./loop.ts";
import { stableSystem, volatileSystem } from "./prompt.ts";
import { formatLocal, truncate } from "../util.ts";

const CONCURRENCY = 2;
const STEPS_PER_RUN = 50;
const MAX_RUNS = 6;

/**
 * Background tasks: long jobs that keep running when the user is away. Each task keeps its
 * own transcript (persisted after every step, so a restart resumes it), reports progress on
 * the Tasks tab, and posts to its channel when it finishes or needs the user.
 */
export class TaskRunner {
  private queue: string[] = [];
  private running = new Map<string, AbortController>();
  private runs = new Map<string, number>();

  constructor(private app: App) {}

  /** Resume tasks that were mid-flight when the server stopped. */
  recover() {
    for (const t of this.app.store.listTasks(["running", "queued"])) {
      this.app.store.updateTask(t.id, { status: "queued" });
      this.enqueue(t.id);
    }
  }

  enqueue(id: string) {
    if (!this.queue.includes(id) && !this.running.has(id)) this.queue.push(id);
    this.pump();
  }

  private pump() {
    while (this.running.size < CONCURRENCY && this.queue.length) {
      const id = this.queue.shift()!;
      const ac = new AbortController();
      this.running.set(id, ac);
      void this.run(id, ac)
        .catch((e) => {
          this.app.store.log("error", "Task crashed", String(e), null, id);
          try {
            this.app.store.updateTask(id, { status: "failed", progress: String(e) });
          } catch {}
        })
        .finally(() => {
          this.running.delete(id);
          this.pump();
        });
    }
  }

  cancel(id: string): Task {
    this.queue = this.queue.filter((q) => q !== id);
    this.running.get(id)?.abort();
    for (const a of this.app.store.listApprovals("pending").filter((a) => a.taskId === id)) {
      if (this.app.store.claimApproval(a.id, "expired")) this.app.store.setApproval(a.id, { status: "expired" });
    }
    return this.app.store.updateTask(id, { status: "cancelled" });
  }

  complete(id: string): Task {
    this.running.get(id)?.abort();
    return this.app.store.updateTask(id, { status: "completed" });
  }

  /** User answered a task's question (or just added guidance). */
  reply(id: string, content: string): Task {
    const t = this.app.store.getTask(id);
    if (!t) throw new Error("task not found");
    this.appendNote(id, `The user replied: ${content}`);
    this.app.store.addMessage({ channelId: t.channelId, role: "user", kind: "chat", content, taskId: id, emit: false });
    if (["completed", "cancelled"].includes(t.status)) throw new Error(`Task is ${t.status}`);
    this.runs.set(id, 0);
    const task = this.app.store.updateTask(id, { status: "queued", pendingQuestion: null });
    this.enqueue(id);
    return task;
  }

  /** An approval this task was waiting on was decided. */
  resumeWithNote(id: string, note: string) {
    const t = this.app.store.getTask(id);
    if (!t || ["completed", "cancelled", "failed", "suggested_done"].includes(t.status)) return;
    this.appendNote(id, note);
    // Keep waiting while other approvals for this task are still pending.
    const stillPending = this.app.store.listApprovals("pending").some((a) => a.taskId === id);
    if (stillPending || t.status === "running" || t.status === "queued") return;
    if (t.status === "waiting_input") return; // its question is still open; the note will be seen on reply
    this.app.store.updateTask(id, { status: "queued" });
    this.enqueue(id);
  }

  requestInput(id: string, question: string) {
    this.app.store.updateTask(id, { pendingQuestion: question });
  }

  suggestDone(id: string, summary: string) {
    this.app.store.updateTask(id, { progress: truncate(summary, 300) });
    this.app.kv.set(`task_summary_${id}`, summary);
  }

  private appendNote(id: string, note: string) {
    const tr = this.app.store.taskTranscript(id);
    const text = `<system_note at="${formatLocal(Date.now(), this.app.settings.get().timezone)}">${note}</system_note>`;
    const last = tr[tr.length - 1];
    if (last?.role === "user") last.content.push({ type: "text", text });
    else tr.push({ role: "user", content: [{ type: "text", text }] });
    this.app.store.updateTask(id, { transcript: tr });
  }

  private async run(id: string, abort: AbortController) {
    const { app } = this;
    const task = app.store.getTask(id);
    if (!task || task.status !== "queued") return;
    const s = app.settings.get();
    const runNo = (this.runs.get(id) ?? 0) + 1;
    this.runs.set(id, runNo);
    app.store.updateTask(id, { status: "running" });
    app.store.log("task", `Task running: ${task.title}`, null, task.channelId, id);

    let transcript: LlmMessage[] = app.store.taskTranscript(id);
    if (!transcript.length) {
      transcript = [
        {
          role: "user",
          content: [{ type: "text", text: `# Task: ${task.title}\n\n${task.brief}\n\n(Started ${formatLocal(task.createdAt, s.timezone)}. Work through it end to end, then call task_done.)` }],
        },
      ];
    } else {
      // New run: drop earlier reasoning blocks (a leading run of them may always be removed) so
      // the transcript stays valid even though the system prompt and tool list may have changed.
      transcript = transcript.map((m) => ({ ...m, content: m.content.filter((b) => b.type !== "reasoning") })).filter((m) => m.content.length);
    }

    const result = await runLoop({
      app,
      channelId: task.channelId,
      taskId: id,
      background: false, // user-requested work: billed to the task budget, not the daily background budget
      models: [s.models.work, ...s.models.fallbacks],
      effort: "high",
      system: { stable: stableSystem(), volatile: volatileSystem(app, { mode: "task", channelId: task.channelId, taskId: id, query: task.brief }) },
      messages: transcript,
      query: `${task.title}\n${task.brief}`,
      tools: app.tools({ task: true }),
      signal: abort.signal,
      maxSteps: STEPS_PER_RUN,
      onStep: ({ text, views, model }) => {
        const cur = app.store.getTask(id);
        app.store.updateTask(id, { steps: (cur?.steps ?? 0) + 1, transcript });
        if (text.trim() || views.length) {
          app.store.addMessage({ channelId: task.channelId, role: "assistant", kind: "chat", content: text.trim(), toolCalls: views, taskId: id, model });
        }
      },
      shouldStop: () => {
        const cap = app.settings.get().budget.perTaskUsd;
        const spent = app.providers.taskSpend(id);
        return cap > 0 && spent >= cap ? `this task has used $${spent.toFixed(2)} of its $${cap} budget` : null;
      },
    });
    app.store.updateTask(id, { transcript });

    const t = app.store.getTask(id)!;
    if (t.status === "cancelled" || t.status === "completed") return;
    const link = `/?task=${id}`;
    const post = (content: string, notifyTitle: string, urgent = false) => {
      app.store.addMessage({ channelId: task.channelId, role: "assistant", kind: "task_update", content, taskId: id, artifactIds: t.artifactIds });
      void app.notifier.send({ title: notifyTitle, body: content.replace(/[*_#`]/g, "").slice(0, 300), url: link, urgent });
    };

    switch (result.end) {
      case "task_done": {
        const summary = app.kv.get<string>(`task_summary_${id}`, result.lastText || "Done.");
        const pending = app.store.listApprovals("pending").filter((a) => a.taskId === id);
        app.store.updateTask(id, { status: pending.length ? "waiting_approval" : "suggested_done" });
        post(
          `**${task.title}** — ${pending.length ? "ready, waiting on your approval" : "done"}\n\n${summary}`,
          pending.length ? `Approval needed: ${task.title}` : `Done: ${task.title}`,
        );
        break;
      }
      case "ask_user": {
        const q = app.store.taskPendingQuestion(id) ?? "I need your input.";
        app.store.updateTask(id, { status: "waiting_input" });
        post(`**${task.title}** needs you:\n\n${q}`, `Question: ${task.title}`);
        break;
      }
      case "done": {
        const pending = app.store.listApprovals("pending").filter((a) => a.taskId === id);
        if (pending.length) {
          app.store.updateTask(id, { status: "waiting_approval", progress: `Waiting on ${pending.length} approval(s)` });
          post(`**${task.title}** is waiting on your approval for: ${pending.map((p) => p.title).join("; ")}`, `Approval needed: ${task.title}`);
        } else {
          app.store.updateTask(id, { status: "suggested_done", progress: truncate(result.lastText, 300) });
          post(`**${task.title}** — done\n\n${result.lastText || "Finished."}`, `Done: ${task.title}`);
        }
        break;
      }
      case "max_steps":
        if (runNo < MAX_RUNS) {
          app.store.updateTask(id, { status: "queued" });
          this.enqueue(id);
        } else {
          app.store.updateTask(id, { status: "waiting_input", progress: "Long-running; paused for a check-in" });
          post(`**${task.title}** has taken a lot of steps. Reply on the task to keep going or adjust the plan.`, `Paused: ${task.title}`);
        }
        break;
      case "budget":
        app.store.updateTask(id, { status: "waiting_input", progress: `Paused: ${result.error}` });
        post(`**${task.title}** paused — ${result.error}. Raise the per-task budget in Settings or reply “continue”.`, `Paused: ${task.title}`);
        break;
      case "stopped":
        break;
      case "refused":
      case "error":
        app.store.updateTask(id, { status: "failed", progress: result.error ?? "The model declined." });
        post(`**${task.title}** failed: ${result.error ?? "the model declined to continue."}`, `Failed: ${task.title}`);
        break;
    }
  }
}
