import type { App } from "../app.ts";
import type { Approval } from "../shared.ts";
import { runTool } from "./gate.ts";

type Request = Omit<Approval, "id" | "status" | "createdAt" | "decidedAt" | "result"> & { toolCallId?: string };

const RISK_EMOJI: Record<string, string> = { external: "✉️", payment: "💳", sign: "✍️", delete: "🗑️" };

/**
 * Approval cards. The agent never waits on them: it queues the action and carries on.
 * When the user decides, the action runs (with any edits they made) and the outcome is fed
 * back — to the waiting task, or into the channel as a note for the next turn.
 */
export class Approvals {
  constructor(private app: App) {}

  request(r: Request): Approval {
    const ap = this.app.store.createApproval(r);
    this.app.store.addMessage({ channelId: r.channelId, role: "assistant", kind: "approval", content: r.title, approvalId: ap.id, taskId: r.taskId });
    void this.app.notifier.send({
      title: `${RISK_EMOJI[r.risk] ?? "✋"} Approve: ${r.title}`,
      body: r.preview.slice(0, 240),
      url: `/?approval=${ap.id}`,
      approvalId: ap.id,
    });
    return ap;
  }

  async decide(id: string, decision: "approve" | "deny", edits?: Record<string, unknown>, note?: string): Promise<Approval> {
    const { app } = this;
    const ap = app.store.getApproval(id);
    if (!ap) throw new Error("Approval not found");
    if (!app.store.claimApproval(id, decision === "approve" ? "approved" : "denied")) {
      throw new Error(`Already ${ap.status}`);
    }

    if (decision === "deny") {
      const done = app.store.setApproval(id, { status: "denied" });
      app.store.log("approval", `Declined: ${ap.title}`, note ?? null, ap.channelId, ap.taskId);
      const text = `The user declined: ${ap.title}${note ? ` — “${note}”` : ""}. Don't retry it unless they ask.`;
      this.feedBack(ap, text, false);
      return done;
    }

    const args = edits && Object.keys(edits).length ? { ...ap.args, ...edits } : ap.args;
    const tool = app.tools({ task: !!ap.taskId }).find((t) => t.name === ap.toolName);
    if (!tool) {
      const failed = app.store.setApproval(id, { status: "failed", result: "Tool is no longer available (connector disconnected?)" });
      this.feedBack(ap, `Approved but failed: ${ap.title} — the tool is no longer available.`, true);
      return failed;
    }
    app.store.setApproval(id, { status: "approved", args });
    const ac = new AbortController();
    const outcome = await runTool(tool, args, { app, channelId: ap.channelId, taskId: ap.taskId, background: true, signal: ac.signal }, `approval_${id}`);
    const ok = outcome.view.status === "ok";
    const result = outcome.result.content.replace(/<\/?untrusted_content[^>]*>/g, "").slice(0, 4000);
    const done = app.store.setApproval(id, { status: ok ? "executed" : "failed", result });
    app.store.log("approval", `${ok ? "Approved & done" : "Approved but failed"}: ${ap.title}`, result.slice(0, 400), ap.channelId, ap.taskId);
    // The result came from outside — keep it fenced so it's read as data, not instructions.
    const fenced = `\n\n<untrusted_content source="${ap.toolName} result">\n${result.slice(0, 1500)}\n</untrusted_content>`;
    this.feedBack(
      ap,
      ok ? `Approved and done: ${ap.title}${edits ? " (you edited it first)" : ""}.${fenced}` : `Approved, but it failed: ${ap.title}.${fenced}`,
      !ok,
    );
    return done;
  }

  private feedBack(ap: Approval, text: string, needsFollowUp: boolean) {
    const { app } = this;
    if (ap.taskId) {
      app.tasks.resumeWithNote(ap.taskId, text);
      return;
    }
    app.store.addMessage({ channelId: ap.channelId, role: "system", kind: "system", content: text });
    // A failure deserves a reaction now; a success is just context for the next turn.
    if (needsFollowUp) void app.agent.turn(ap.channelId, { mode: "chat", background: true });
  }

  /** Expire approvals nobody acted on for a week. */
  expireOld(maxAgeMs = 7 * 86400_000) {
    for (const a of this.app.store.listApprovals("pending")) {
      if (Date.now() - a.createdAt > maxAgeMs && this.app.store.claimApproval(a.id, "expired")) {
        this.app.store.setApproval(a.id, { status: "expired" });
        if (a.taskId) this.app.tasks.resumeWithNote(a.taskId, `Approval for “${a.title}” expired without a decision.`);
      }
    }
  }
}
