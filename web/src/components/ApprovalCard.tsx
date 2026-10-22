import clsx from "clsx";
import { AlertTriangle, Check, ChevronDown, Pencil, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import type { Approval } from "@shared";
import { api } from "../api";
import { timeAgo } from "../util";
import { Button, RiskBadge, Textarea } from "./ui";

const STATUS_TEXT: Record<Approval["status"], string> = {
  pending: "Waiting for you",
  approved: "Approved — running…",
  executed: "Done",
  denied: "Not sent",
  expired: "Expired",
  failed: "Failed",
};

export function ApprovalCard({ approval, compact }: { approval: Approval; compact?: boolean }) {
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [editing, setEditing] = useState(false);
  const [showArgs, setShowArgs] = useState(false);
  const [draft, setDraft] = useState(() => JSON.stringify(approval.args, null, 2));
  const [error, setError] = useState<string | null>(null);
  const pending = approval.status === "pending";

  async function decide(decision: "approve" | "deny") {
    setError(null);
    let edits: Record<string, unknown> | undefined;
    if (decision === "approve" && editing) {
      try {
        edits = JSON.parse(draft);
      } catch {
        setError("That isn't valid JSON.");
        return;
      }
    }
    setBusy(decision);
    try {
      await api.decide(approval.id, decision, edits);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      className={clsx(
        "overflow-hidden rounded-2xl border bg-card transition",
        pending ? "border-accent/40 shadow-[0_1px_0_var(--line),0_8px_24px_-16px_rgba(226,98,44,0.45)]" : "border-line",
      )}
    >
      <div className="flex items-start gap-3 px-4 pb-2 pt-3.5">
        <div className={clsx("mt-0.5 grid size-7 shrink-0 place-items-center rounded-full", pending ? "bg-accent-soft text-accent" : "bg-sunk text-muted")}>
          <ShieldCheck size={15} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <RiskBadge risk={approval.risk} />
            <span className="text-xs text-faint">{timeAgo(approval.createdAt)}</span>
          </div>
          <div className="mt-1 text-[15px] font-medium leading-snug text-ink">{approval.title}</div>
        </div>
      </div>

      {approval.preview && !editing ? (
        <div className={clsx("mx-4 mb-3 whitespace-pre-wrap rounded-xl bg-sunk px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-ink/85", compact ? "max-h-40 overflow-y-auto" : "max-h-72 overflow-y-auto")}>
          {approval.preview}
        </div>
      ) : null}

      {approval.warnings.length ? (
        <div className="mx-4 mb-3 space-y-1">
          {approval.warnings.map((w, i) => (
            <div key={i} className="flex gap-2 rounded-lg bg-danger-soft px-2.5 py-1.5 text-[13px] text-danger">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{w}</span>
            </div>
          ))}
        </div>
      ) : null}

      {editing ? (
        <div className="mx-4 mb-3">
          <Textarea rows={Math.min(14, draft.split("\n").length + 1)} value={draft} onChange={(e) => setDraft(e.target.value)} className="font-mono text-[12.5px]" spellCheck={false} />
          <p className="mt-1 text-xs text-faint">Approving sends exactly these arguments.</p>
        </div>
      ) : pending ? (
        <button onClick={() => setShowArgs((s) => !s)} className="mx-4 mb-2 flex items-center gap-1 text-xs text-faint hover:text-muted">
          <ChevronDown size={13} className={clsx("transition", showArgs && "rotate-180")} />
          {approval.toolName}
        </button>
      ) : null}
      {showArgs && !editing ? (
        <pre className="mx-4 mb-3 max-h-48 overflow-auto rounded-xl bg-sunk px-3 py-2 font-mono text-[11.5px] text-muted">{JSON.stringify(approval.args, null, 2)}</pre>
      ) : null}

      {error ? <p className="mx-4 mb-2 text-[13px] text-danger">{error}</p> : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-line bg-paper/40 px-4 py-2.5">
        {pending ? (
          <>
            <Button size="sm" variant="accent" busy={busy === "approve"} disabled={!!busy} onClick={() => decide("approve")}>
              <Check size={14} /> {editing ? "Approve edited" : "Approve"}
            </Button>
            <Button size="sm" variant="quiet" busy={busy === "deny"} disabled={!!busy} onClick={() => decide("deny")}>
              <X size={14} /> Not now
            </Button>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setEditing((e) => !e)} title="Edit before approving">
              <Pencil size={13} /> {compact ? null : editing ? "Cancel edit" : "Edit"}
            </Button>
          </>
        ) : (
          <div className="flex w-full items-center gap-2 text-[13px]">
            <span className={clsx("font-medium", approval.status === "executed" ? "text-ok" : approval.status === "failed" ? "text-danger" : "text-muted")}>{STATUS_TEXT[approval.status]}</span>
            {approval.decidedAt ? <span className="text-faint">· {timeAgo(approval.decidedAt)}</span> : null}
            {approval.result && approval.status !== "denied" ? <span className="min-w-0 flex-1 truncate text-right text-faint" title={approval.result}>{approval.result}</span> : null}
          </div>
        )}
      </div>
    </div>
  );
}
