import { CheckCircle2, CircleHelp, Coffee, Flag } from "lucide-react";
import type { Task } from "@shared";
import { ApprovalCard } from "../components/ApprovalCard";
import { Sheet } from "../components/ui";
import { useNeedsYouTasks, usePendingApprovals, useStore } from "../store";
import { navigate, timeAgo } from "../util";

const TASK_REASON: Partial<Record<Task["status"], { icon: React.ReactNode; text: string }>> = {
  waiting_input: { icon: <CircleHelp size={15} />, text: "Has a question for you" },
  suggested_done: { icon: <Flag size={15} />, text: "Thinks it's finished — review and mark done" },
  waiting_approval: { icon: <CircleHelp size={15} />, text: "Waiting on an approval" },
};

export function NeedsYou({ compact }: { compact?: boolean }) {
  const approvals = usePendingApprovals();
  const tasks = useNeedsYouTasks().filter((t) => t.status !== "waiting_approval");
  const empty = approvals.length === 0 && tasks.length === 0;

  return (
    <div className={compact ? "p-4" : "px-5 py-5"}>
      {compact ? null : (
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="font-display text-lg font-semibold">Needs you</h2>
          {!empty ? <span className="text-sm text-muted">{approvals.length + tasks.length}</span> : null}
        </div>
      )}
      {empty ? (
        <div className="rounded-2xl border border-dashed border-line px-4 py-8 text-center">
          <Coffee size={20} className="mx-auto text-faint" />
          <p className="mt-2 text-sm text-muted">Nothing waiting on you.</p>
          <p className="mt-1 text-xs text-faint">Approvals and questions from tasks show up here.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {approvals.map((a) => (
            <ApprovalCard key={a.id} approval={a} compact />
          ))}
          {tasks.map((t) => {
            const r = TASK_REASON[t.status]!;
            return (
              <button
                key={t.id}
                onClick={() => navigate({ task: t.id })}
                className="block w-full rounded-2xl border border-line bg-card px-4 py-3 text-left transition hover:border-agent/40"
              >
                <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-accent">
                  {r.icon}
                  {r.text}
                </div>
                <div className="mt-1 text-[14.5px] font-medium leading-snug">{t.title}</div>
                {t.progress ? <div className="mt-1 line-clamp-2 text-[13px] text-muted">{t.progress}</div> : null}
                <div className="mt-1.5 text-xs text-faint">{timeAgo(t.updatedAt)}</div>
              </button>
            );
          })}
        </div>
      )}
      {compact ? null : <RecentlyDone />}
    </div>
  );
}

function RecentlyDone() {
  const { state } = useStore();
  const done = Object.values(state.approvals)
    .filter((a) => a.status === "executed" && a.decidedAt && Date.now() - a.decidedAt < 86400_000)
    .sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0))
    .slice(0, 5);
  if (!done.length) return null;
  return (
    <div className="mt-8">
      <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.08em] text-faint">Done today</h3>
      <ul className="space-y-1.5">
        {done.map((a) => (
          <li key={a.id} className="flex gap-2 text-[13px] text-muted">
            <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-ok" />
            <span className="line-clamp-2">{a.title}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ApprovalSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const { state } = useStore();
  const a = state.approvals[id];
  return (
    <Sheet open onClose={onClose} title="Approval">
      <div className="p-4">{a ? <ApprovalCard approval={a} /> : <p className="text-sm text-muted">This approval is no longer available.</p>}</div>
    </Sheet>
  );
}
