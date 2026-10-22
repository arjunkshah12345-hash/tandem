import clsx from "clsx";
import { AlertCircle, Bell, CalendarClock, CheckSquare, Globe, Hand, Info, Radar, ShieldCheck, Sun, Wrench } from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { ActivityEntry } from "@shared";
import { api } from "../api";
import { Button, Empty, Input } from "../components/ui";
import { useStore } from "../store";
import { clock, dayLabel, navigate, timeAgo } from "../util";

const KIND: Record<ActivityEntry["kind"], { icon: React.ReactNode; label: string }> = {
  tool: { icon: <Wrench size={14} />, label: "Actions" },
  approval: { icon: <ShieldCheck size={14} />, label: "Approvals" },
  checkin: { icon: <Radar size={14} />, label: "Check-ins" },
  brief: { icon: <Sun size={14} />, label: "Briefs" },
  routine: { icon: <CalendarClock size={14} />, label: "Routines" },
  task: { icon: <CheckSquare size={14} />, label: "Tasks" },
  error: { icon: <AlertCircle size={14} />, label: "Errors" },
  notify: { icon: <Bell size={14} />, label: "Notifications" },
  system: { icon: <Info size={14} />, label: "System" },
};

export function ActivityView() {
  const { state, loadActivity } = useStore();
  const [filter, setFilter] = useState<ActivityEntry["kind"] | "all">("all");
  const [open, setOpen] = useState<string | null>(null);
  const [more, setMore] = useState(true);

  useEffect(() => {
    void loadActivity();
  }, [loadActivity]);

  const list = state.activity.filter((e) => filter === "all" || e.kind === filter);

  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[920px] px-4 py-6 md:px-8 md:py-10">
        <h1 className="font-display text-[28px] font-semibold tracking-tight">Activity</h1>
        <p className="mt-1 text-sm text-muted">Everything Tandem did on your behalf, including the quiet check-ins. Nothing happens off the record.</p>

        {state.browser ? <LiveBrowser /> : null}

        <div className="scroll-thin -mx-1 mt-6 flex gap-1.5 overflow-x-auto px-1 pb-1">
          {(["all", "tool", "approval", "checkin", "brief", "task", "routine", "notify", "error"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              className={clsx("h-8 shrink-0 rounded-full px-3 text-[13px] transition", filter === k ? "bg-ink text-paper" : "bg-sunk text-muted hover:text-ink")}
            >
              {k === "all" ? "All" : KIND[k].label}
            </button>
          ))}
        </div>

        {list.length === 0 ? (
          <Empty icon={<Radar size={22} />} title="Quiet so far">
            Check-ins, actions and approvals will be logged here.
          </Empty>
        ) : (
          <ul className="mt-4">
            {list.map((e, i) => {
              const newDay = i === 0 || new Date(list[i - 1].at).toDateString() !== new Date(e.at).toDateString();
              const k = KIND[e.kind];
              return (
                <li key={e.id}>
                  {newDay ? <div className="mb-1 mt-5 text-[12px] font-semibold uppercase tracking-[0.08em] text-faint">{dayLabel(e.at)}</div> : null}
                  <button onClick={() => setOpen(open === e.id ? null : e.id)} className="flex w-full items-start gap-3 rounded-xl px-2 py-2 text-left hover:bg-sunk/60">
                    <span className={clsx("mt-0.5 grid size-6 shrink-0 place-items-center rounded-full", e.kind === "error" ? "bg-danger-soft text-danger" : "bg-sunk text-muted")}>{k.icon}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[14px] leading-snug text-ink">{e.summary}</span>
                      {open === e.id && e.detail ? <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-sunk p-2.5 font-mono text-[12px] text-muted">{e.detail}</pre> : null}
                      {open === e.id && (e.taskId || e.channelId) ? (
                        <span className="mt-1.5 flex gap-3 text-[12.5px]">
                          {e.taskId ? (
                            <a className="text-agent hover:underline" onClick={(ev) => (ev.stopPropagation(), navigate({ task: e.taskId }))}>
                              Open task
                            </a>
                          ) : null}
                          {e.channelId ? (
                            <a className="text-agent hover:underline" onClick={(ev) => (ev.stopPropagation(), navigate({ view: null, channel: e.channelId === "main" ? null : e.channelId }))}>
                              Open thread
                            </a>
                          ) : null}
                        </span>
                      ) : null}
                    </span>
                    <span className="shrink-0 pt-0.5 text-[12px] tabular-nums text-faint" title={new Date(e.at).toLocaleString()}>
                      {clock(e.at)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {state.activity.length >= 100 && more ? (
          <div className="mt-4 flex justify-center">
            <Button
              size="sm"
              onClick={async () => {
                const n = state.activity.length;
                await loadActivity(true);
                if (n === state.activity.length) setMore(false);
              }}
            >
              Load older
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function LiveBrowser() {
  const { state } = useStore();
  const b = state.browser!;
  const img = useRef<HTMLImageElement>(null);
  const [control, setControl] = useState(false);
  const [text, setText] = useState("");
  const [url, setUrl] = useState(b.url);
  const [error, setError] = useState<string | null>(null);
  const fresh = Date.now() - b.at < 60_000;

  useEffect(() => setUrl(b.url), [b.url]);

  async function send(body: Parameters<typeof api.takeover>[0]) {
    setError(null);
    try {
      await api.takeover(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function click(e: MouseEvent<HTMLImageElement>) {
    if (!control || !img.current) return;
    const r = img.current.getBoundingClientRect();
    const sx = img.current.naturalWidth / r.width;
    const sy = img.current.naturalHeight / r.height;
    void send({ action: "click", x: Math.round((e.clientX - r.left) * sx), y: Math.round((e.clientY - r.top) * sy) });
  }

  return (
    <section className="mt-6 overflow-hidden rounded-2xl border border-line bg-card">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Globe size={15} className="shrink-0 text-muted" />
        {control ? (
          <form
            className="flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              void send({ action: "navigate", url });
            }}
          >
            <Input value={url} onChange={(e) => setUrl(e.target.value)} className="h-8 text-[13px]" />
          </form>
        ) : (
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium">{b.title || "Browser"}</div>
            <div className="truncate text-[11.5px] text-faint">{b.url}</div>
          </div>
        )}
        <span className={clsx("flex shrink-0 items-center gap-1 text-[11.5px]", fresh ? "text-ok" : "text-faint")}>
          <span className={clsx("size-1.5 rounded-full", fresh ? "animate-pulse bg-ok" : "bg-faint")} />
          {fresh ? "Live" : timeAgo(b.at)}
        </span>
        <Button size="sm" variant={control ? "accent" : "quiet"} onClick={() => setControl((c) => !c)}>
          <Hand size={14} /> {control ? "Hand back" : "Take over"}
        </Button>
      </div>
      <img ref={img} src={b.image} alt="Tandem's browser" onClick={click} className={clsx("block w-full select-none", control && "cursor-crosshair")} draggable={false} />
      {control ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-line p-2.5">
          <form
            className="flex min-w-[200px] flex-1 gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!text) return;
              void send({ action: "type", text }).then(() => setText(""));
            }}
          >
            <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type into the focused field…" className="h-8 text-[13px]" />
            <Button size="sm" type="submit" variant="primary">
              Type
            </Button>
          </form>
          {["Enter", "Tab", "Escape", "Backspace"].map((k) => (
            <Button key={k} size="sm" onClick={() => void send({ action: "key", text: k })}>
              {k}
            </Button>
          ))}
          {error ? <span className="w-full text-[12.5px] text-danger">{error}</span> : null}
          <p className="w-full text-[11.5px] text-faint">Click the screenshot to click the page. Use this for logins and CAPTCHAs; for passwords, prefer a saved secret so the value never appears in chat.</p>
        </div>
      ) : null}
    </section>
  );
}
