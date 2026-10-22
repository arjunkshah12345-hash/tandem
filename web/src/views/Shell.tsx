import clsx from "clsx";
import { Activity, CheckSquare, Hash, LogOut, MessageCircle, Plus, Settings as SettingsIcon, Shapes } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api } from "../api";
import { Input, Sheet } from "../components/ui";
import { useNeedsYouTasks, usePendingApprovals, useStore } from "../store";
import { navigate, useQueryState } from "../util";
import { ActivityView } from "./Activity";
import { ApprovalSheet, NeedsYou } from "./NeedsYou";
import { MakeView } from "./Make";
import { SettingsView } from "./Settings";
import { TaskDrawer, TasksView } from "./Tasks";
import { Thread } from "./Thread";

export type View = "thread" | "tasks" | "make" | "activity" | "settings";

const NAV: { view: View; label: string; icon: ReactNode }[] = [
  { view: "thread", label: "Thread", icon: <MessageCircle size={19} /> },
  { view: "tasks", label: "Tasks", icon: <CheckSquare size={19} /> },
  { view: "make", label: "Make", icon: <Shapes size={19} /> },
  { view: "activity", label: "Activity", icon: <Activity size={19} /> },
  { view: "settings", label: "Settings", icon: <SettingsIcon size={19} /> },
];

export function Shell({ onLogout }: { onLogout: () => void }) {
  const q = useQueryState();
  const view = (q.get("view") as View) || "thread";
  const channelId = q.get("channel") || "main";
  const taskId = q.get("task");
  const approvalId = q.get("approval");
  const { state } = useStore();
  const approvals = usePendingApprovals();
  const needTasks = useNeedsYouTasks();
  const needsCount = approvals.length + needTasks.length;
  const [needsOpen, setNeedsOpen] = useState(false);

  useEffect(() => {
    const pending = needsCount ? `(${needsCount}) ` : "";
    document.title = `${pending}Tandem`;
  }, [needsCount]);

  return (
    <div className="flex h-full">
      {/* Left rail (desktop) */}
      <aside className="hidden w-[248px] shrink-0 flex-col border-r border-line bg-paper md:flex">
        <div className="flex items-center gap-2.5 px-5 pb-4 pt-5">
          <img src="/icon.svg" alt="" className="size-7 rounded-lg" />
          <span className="font-display text-[19px] font-semibold tracking-tight">Tandem</span>
          <span className={clsx("ml-auto size-2 rounded-full", state.connected ? "bg-ok" : "bg-faint")} title={state.connected ? "Live" : "Reconnecting…"} />
        </div>
        <nav className="scroll-thin flex-1 space-y-0.5 overflow-y-auto px-3">
          {NAV.map((n) => (
            <div key={n.view}>
              <RailItem active={view === n.view && !(n.view === "thread" && channelId !== "main")} onClick={() => navigate({ view: n.view === "thread" ? null : n.view, channel: null })} icon={n.icon}>
                {n.label}
                {n.view === "tasks" && needTasks.length ? <Count tone="accent">{needTasks.length}</Count> : null}
                {n.view === "thread" ? <Count>{state.channels.find((c) => c.id === "main")?.unread || 0}</Count> : null}
              </RailItem>
              {n.view === "thread" ? <ChannelList active={view === "thread" ? channelId : null} /> : null}
            </div>
          ))}
        </nav>
        <div className="border-t border-line p-3">
          <RailItem
            icon={<LogOut size={17} />}
            onClick={async () => {
              await api.logout();
              onLogout();
            }}
          >
            Sign out
          </RailItem>
        </div>
      </aside>

      {/* Main */}
      <main className="flex min-w-0 flex-1 flex-col">
        {view === "thread" ? <Thread channelId={channelId} needsCount={needsCount} onOpenNeeds={() => setNeedsOpen(true)} /> : null}
        {view === "tasks" ? <TasksView /> : null}
        {view === "make" ? <MakeView /> : null}
        {view === "activity" ? <ActivityView /> : null}
        {view === "settings" ? <SettingsView /> : null}

        {/* Bottom tabs (mobile) */}
        <nav className="flex shrink-0 border-t border-line bg-paper pb-[env(safe-area-inset-bottom)] md:hidden">
          {NAV.map((n) => (
            <button
              key={n.view}
              onClick={() => navigate({ view: n.view === "thread" ? null : n.view, channel: null })}
              className={clsx("relative flex flex-1 flex-col items-center gap-0.5 pb-1.5 pt-2 text-[10.5px] font-medium", view === n.view ? "text-ink" : "text-faint")}
            >
              {n.icon}
              {n.label}
              {n.view === "tasks" && needTasks.length ? <span className="absolute right-[calc(50%-16px)] top-1.5 size-2 rounded-full bg-accent" /> : null}
            </button>
          ))}
        </nav>
      </main>

      {/* Right panel (wide desktop) */}
      {view === "thread" || view === "tasks" ? (
        <aside className="scroll-thin hidden w-[340px] shrink-0 overflow-y-auto border-l border-line bg-paper xl:block">
          <NeedsYou />
        </aside>
      ) : null}

      <Sheet open={needsOpen} onClose={() => setNeedsOpen(false)} title="Needs you">
        <NeedsYou compact />
      </Sheet>
      {taskId ? <TaskDrawer id={taskId} onClose={() => navigate({ task: null })} /> : null}
      {approvalId ? <ApprovalSheet id={approvalId} onClose={() => navigate({ approval: null })} /> : null}
    </div>
  );
}

function RailItem({ active, onClick, icon, children }: { active?: boolean; onClick: () => void; icon: ReactNode; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        "flex h-9 w-full items-center gap-2.5 rounded-xl px-2.5 text-left text-[14px] transition",
        active ? "bg-card font-medium text-ink shadow-[0_1px_0_var(--line)]" : "text-muted hover:bg-sunk hover:text-ink",
      )}
    >
      <span className="shrink-0 opacity-80">{icon}</span>
      <span className="flex min-w-0 flex-1 items-center gap-2 truncate">{children}</span>
    </button>
  );
}

function Count({ children, tone }: { children: number; tone?: "accent" }) {
  if (!children) return null;
  return (
    <span className={clsx("ml-auto rounded-full px-1.5 text-[11px] font-semibold leading-[18px]", tone === "accent" ? "bg-accent text-white" : "bg-agent text-paper")}>
      {children}
    </span>
  );
}

function ChannelList({ active }: { active: string | null }) {
  const { state, refresh } = useStore();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const channels = state.channels.filter((c) => c.id !== "main" && !c.archived);

  async function add(e: FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    const ch = await api.createChannel(n);
    setName("");
    setAdding(false);
    await refresh();
    navigate({ view: null, channel: ch.id });
  }

  return (
    <div className="mb-2 ml-5 mt-0.5 border-l border-line pl-2">
      {channels.map((c) => (
        <button
          key={c.id}
          onClick={() => navigate({ view: null, channel: c.id })}
          className={clsx(
            "flex h-8 w-full items-center gap-1.5 rounded-lg px-2 text-left text-[13.5px] transition",
            active === c.id ? "bg-card font-medium text-ink" : "text-muted hover:bg-sunk hover:text-ink",
          )}
        >
          <Hash size={13} className="shrink-0 opacity-60" />
          <span className="truncate">{c.name}</span>
          {c.unread ? <span className="ml-auto size-1.5 shrink-0 rounded-full bg-agent" /> : null}
        </button>
      ))}
      {adding ? (
        <form onSubmit={add} className="py-1">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onBlur={() => !name && setAdding(false)} placeholder="Channel name" className="h-8 text-[13px]" />
        </form>
      ) : (
        <button onClick={() => setAdding(true)} className="flex h-8 w-full items-center gap-1.5 rounded-lg px-2 text-[13px] text-faint hover:text-ink">
          <Plus size={13} /> New channel
        </button>
      )}
    </div>
  );
}
