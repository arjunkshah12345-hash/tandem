import clsx from "clsx";
import { Check, CheckSquare, CircleHelp, Flag, Loader2, Plus, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { Message, Task, TaskStatus } from "@shared";
import { api } from "../api";
import { Markdown } from "../components/Markdown";
import { Button, Empty, Field, Input, Pill, Sheet, Spinner, Textarea } from "../components/ui";
import { useStore } from "../store";
import { clock, navigate, timeAgo } from "../util";

const STATUS: Record<TaskStatus, { label: string; tone: "muted" | "agent" | "accent" | "danger" | "ok" }> = {
  queued: { label: "Queued", tone: "muted" },
  running: { label: "Working", tone: "agent" },
  waiting_input: { label: "Question for you", tone: "accent" },
  waiting_approval: { label: "Needs approval", tone: "accent" },
  suggested_done: { label: "Ready for review", tone: "accent" },
  completed: { label: "Completed", tone: "ok" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "muted" },
};

const ACTIVE: TaskStatus[] = ["queued", "running", "waiting_input", "waiting_approval", "suggested_done"];
type Filter = "active" | "completed" | "closed";

export function TasksView() {
  const { state } = useStore();
  const [filter, setFilter] = useState<Filter>("active");
  const [creating, setCreating] = useState(false);
  const all = Object.values(state.tasks).sort((a, b) => b.updatedAt - a.updatedAt);
  const lists: Record<Filter, Task[]> = {
    active: all.filter((t) => ACTIVE.includes(t.status)),
    completed: all.filter((t) => t.status === "completed"),
    closed: all.filter((t) => t.status === "failed" || t.status === "cancelled"),
  };
  const list = lists[filter];

  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[820px] px-4 py-6 md:px-8 md:py-10">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-[28px] font-semibold tracking-tight">Tasks</h1>
            <p className="mt-1 text-sm text-muted">Longer jobs Tandem works on in the background. Only you can mark one complete.</p>
          </div>
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus size={16} /> New task
          </Button>
        </div>

        <div className="mt-6 flex gap-1 border-b border-line">
          {(["active", "completed", "closed"] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={clsx("-mb-px border-b-2 px-3 pb-2.5 text-sm capitalize transition", filter === f ? "border-ink font-medium text-ink" : "border-transparent text-muted hover:text-ink")}
            >
              {f}
              <span className="ml-1.5 text-faint">{lists[f].length}</span>
            </button>
          ))}
        </div>

        {list.length === 0 ? (
          <Empty icon={<CheckSquare size={22} />} title={filter === "active" ? "No tasks in flight" : `No ${filter} tasks`}>
            {filter === "active" ? "Ask in the thread (“research…”, “chase down…”) or start one here. Tasks keep running when you close the app." : null}
          </Empty>
        ) : (
          <ul className="mt-4 space-y-2">
            {list.map((t) => (
              <li key={t.id}>
                <TaskRow task={t} />
              </li>
            ))}
          </ul>
        )}
      </div>
      <NewTaskSheet open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function TaskRow({ task: t }: { task: Task }) {
  const s = STATUS[t.status];
  return (
    <button onClick={() => navigate({ task: t.id })} className="flex w-full items-start gap-3 rounded-2xl border border-line bg-card px-4 py-3.5 text-left transition hover:border-agent/40">
      <StatusIcon status={t.status} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[15px] font-medium leading-snug">{t.title}</span>
          <Pill tone={s.tone}>{s.label}</Pill>
        </div>
        {t.progress ? <p className="mt-1 line-clamp-2 text-[13.5px] text-muted">{t.progress}</p> : null}
        <p className="mt-1.5 text-xs text-faint">
          Updated {timeAgo(t.updatedAt)} · {t.steps} step{t.steps === 1 ? "" : "s"}
          {t.artifactIds.length ? ` · ${t.artifactIds.length} file${t.artifactIds.length === 1 ? "" : "s"}` : ""}
        </p>
      </div>
    </button>
  );
}

function StatusIcon({ status }: { status: TaskStatus }) {
  const base = "mt-0.5 grid size-6 shrink-0 place-items-center rounded-full";
  if (status === "running") return <span className={clsx(base, "bg-agent-soft text-agent")}><Loader2 size={13} className="animate-spin" /></span>;
  if (status === "completed") return <span className={clsx(base, "bg-agent-soft text-ok")}><Check size={13} strokeWidth={3} /></span>;
  if (status === "waiting_input" || status === "waiting_approval") return <span className={clsx(base, "bg-accent-soft text-accent")}><CircleHelp size={13} /></span>;
  if (status === "suggested_done") return <span className={clsx(base, "bg-accent-soft text-accent")}><Flag size={12} /></span>;
  if (status === "failed" || status === "cancelled") return <span className={clsx(base, "bg-sunk text-faint")}><X size={13} /></span>;
  return <span className={clsx(base, "border-2 border-dashed border-line")} />;
}

function NewTaskSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const t = await api.createTask(title.trim(), brief.trim());
      setTitle("");
      setBrief("");
      onClose();
      navigate({ task: t.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="New task">
      <form onSubmit={submit} className="space-y-4 p-5">
        <Field label="Title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Chase overdue invoices" autoFocus required />
        </Field>
        <Field label="Brief" hint="What does done look like? Mention people, files, deadlines, and anything Tandem shouldn't do.">
          <Textarea rows={7} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="Find every invoice over 30 days late in QuickBooks, draft a friendly follow-up for each, and send them after I approve." required />
        </Field>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        <Button type="submit" variant="primary" busy={busy} className="w-full">
          Start task
        </Button>
      </form>
    </Sheet>
  );
}

export function TaskDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { state } = useStore();
  const live = state.tasks[id];
  const [data, setData] = useState<{ task: Task; log: Message[]; question: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .task(id)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [id, live?.updatedAt, live?.steps]);

  const task = live ?? data?.task;

  async function act(name: string, fn: () => Promise<unknown>) {
    setBusy(name);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const open = task && ACTIVE.includes(task.status);

  return (
    <Sheet open onClose={onClose} title={task?.title ?? "Task"} wide>
      {!task ? (
        <div className="flex justify-center py-16 text-faint">{error ? <span className="text-sm text-danger">{error}</span> : <Spinner />}</div>
      ) : (
        <div className="grid gap-0 md:grid-cols-[1fr_300px]">
          <div className="min-w-0 border-line p-5 md:border-r">
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone={STATUS[task.status].tone}>{STATUS[task.status].label}</Pill>
              <span className="text-xs text-faint">
                Started {timeAgo(task.createdAt)} · {task.steps} steps
              </span>
            </div>

            {task.status === "waiting_input" && data?.question ? (
              <div className="mt-4 rounded-2xl border border-accent/40 bg-accent-soft/50 p-4">
                <div className="text-[12px] font-semibold uppercase tracking-[0.07em] text-accent">Question</div>
                <Markdown className="mt-1 text-[15px]">{data.question}</Markdown>
              </div>
            ) : null}
            {task.status === "suggested_done" ? (
              <div className="mt-4 rounded-2xl border border-accent/40 bg-accent-soft/50 p-4 text-[14px]">
                Tandem thinks this is finished. Look over the result, then mark it complete — or reply with what's still missing.
              </div>
            ) : null}

            {open ? (
              <form
                className="mt-4 flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!reply.trim()) return;
                  void act("reply", async () => {
                    await api.replyTask(task.id, reply.trim());
                    setReply("");
                  });
                }}
              >
                <Input value={reply} onChange={(e) => setReply(e.target.value)} placeholder={task.status === "waiting_input" ? "Answer…" : "Add a note or change direction…"} />
                <Button type="submit" variant="primary" busy={busy === "reply"} disabled={!reply.trim()}>
                  Send
                </Button>
              </form>
            ) : null}

            <h3 className="mb-3 mt-7 text-[12px] font-semibold uppercase tracking-[0.08em] text-faint">Work log</h3>
            {!data ? (
              <Spinner className="text-faint" />
            ) : data.log.length === 0 ? (
              <p className="text-sm text-muted">{task.status === "queued" ? "Waiting to start…" : "Nothing yet."}</p>
            ) : (
              <ol className="relative space-y-4 border-l border-line pl-5">
                {data.log.map((m) => (
                  <li key={m.id} className="relative">
                    <span className={clsx("absolute -left-[25px] top-1.5 size-2 rounded-full", m.role === "user" ? "bg-ink" : "bg-agent")} />
                    <div className="text-[11.5px] text-faint">
                      {m.role === "user" ? "You" : "Tandem"} · {clock(m.createdAt)}
                    </div>
                    {m.toolCalls.length ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {m.toolCalls.map((c) => (
                          <span key={c.id} className={clsx("rounded-full bg-sunk px-2 py-0.5 text-[12px]", c.status === "error" || c.status === "blocked" ? "text-danger" : "text-muted")}>
                            {c.summary}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {m.content ? <Markdown className="mt-1 text-[14px]">{m.content}</Markdown> : null}
                  </li>
                ))}
              </ol>
            )}
          </div>

          <div className="space-y-6 p-5">
            <div>
              <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.08em] text-faint">Brief</h3>
              <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-ink/90">{task.brief}</p>
            </div>
            {task.progress ? (
              <div>
                <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.08em] text-faint">Latest</h3>
                <p className="text-[14px] text-muted">{task.progress}</p>
              </div>
            ) : null}
            {task.artifactIds.length ? (
              <div>
                <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.08em] text-faint">Made</h3>
                <div className="space-y-1.5">
                  {task.artifactIds.map((aid) => (
                    <button key={aid} onClick={() => navigate({ view: "make", artifact: aid, task: null })} className="block w-full truncate rounded-xl bg-sunk px-3 py-2 text-left text-[13.5px] hover:bg-line">
                      {state.artifacts[aid]?.title ?? "Artifact"}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {error ? <p className="text-sm text-danger">{error}</p> : null}
            <div className="flex flex-col gap-2">
              {task.status !== "completed" && task.status !== "cancelled" ? (
                <Button variant={task.status === "suggested_done" ? "accent" : "quiet"} busy={busy === "complete"} onClick={() => act("complete", () => api.completeTask(task.id))}>
                  <Check size={15} /> Mark complete
                </Button>
              ) : null}
              {open ? (
                <Button variant="ghost" busy={busy === "cancel"} onClick={() => act("cancel", () => api.cancelTask(task.id))}>
                  Cancel task
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </Sheet>
  );
}
