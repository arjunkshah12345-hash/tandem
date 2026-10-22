import clsx from "clsx";
import { ArrowUp, Bell, CheckSquare, ChevronDown, CircleAlert, FileText, Hash, Loader2, Mic, MicOff, Square, Sun, Wrench } from "lucide-react";
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Message, ToolCallView } from "@shared";
import { api } from "../api";
import { ApprovalCard } from "../components/ApprovalCard";
import { Markdown } from "../components/Markdown";
import { IconButton, Sheet, Spinner } from "../components/ui";
import { useStore } from "../store";
import { clock, dayLabel, greeting, navigate } from "../util";

export function Thread({ channelId, needsCount, onOpenNeeds }: { channelId: string; needsCount: number; onOpenNeeds: () => void }) {
  const { state, loadMessages, markRead } = useStore();
  const channel = state.channels.find((c) => c.id === channelId);
  const messages = state.messages[channelId];
  const typing = state.typing[channelId];
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [switcher, setSwitcher] = useState(false);

  useEffect(() => {
    if (!messages) void loadMessages(channelId);
    stick.current = true;
  }, [channelId, messages, loadMessages]);

  useEffect(() => {
    if (document.visibilityState === "visible") markRead(channelId);
  }, [channelId, messages?.length, markRead]);

  // Keep pinned to the bottom while new content streams in, unless the user scrolled up.
  const streamingLen = Object.values(state.streaming).reduce((n, s) => n + s.length, 0);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, streamingLen, typing?.active]);

  const onScroll = useCallback(async () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 120 && state.hasMore[channelId] && !loadingOlder) {
      setLoadingOlder(true);
      const prevHeight = el.scrollHeight;
      await loadMessages(channelId, true);
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight - prevHeight + el.scrollTop;
        setLoadingOlder(false);
      });
    }
  }, [channelId, loadMessages, loadingOlder, state.hasMore]);

  const title = channelId === "main" ? "Thread" : (channel?.name ?? channelId);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4 md:px-6">
        <button className="flex min-w-0 items-center gap-1.5 md:pointer-events-none" onClick={() => setSwitcher(true)}>
          {channelId !== "main" ? <Hash size={16} className="shrink-0 text-faint" /> : null}
          <span className="truncate font-display text-[17px] font-semibold">{title}</span>
          <ChevronDown size={15} className="text-faint md:hidden" />
        </button>
        {channel?.topic ? <span className="hidden truncate text-sm text-muted lg:inline">— {channel.topic}</span> : null}
        <div className="ml-auto flex items-center gap-1">
          {!state.connected ? <span className="mr-2 text-xs text-faint">Reconnecting…</span> : null}
          {needsCount ? (
            <button onClick={onOpenNeeds} className="flex h-8 items-center gap-1.5 rounded-full bg-accent px-3 text-[13px] font-medium text-white xl:hidden">
              <Bell size={14} /> {needsCount} need{needsCount === 1 ? "s" : ""} you
            </button>
          ) : null}
        </div>
      </header>

      <div ref={scroller} onScroll={onScroll} className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[760px] px-4 pb-6 pt-4 md:px-6">
          {loadingOlder ? (
            <div className="flex justify-center py-3 text-faint">
              <Spinner />
            </div>
          ) : null}
          {!messages ? (
            <div className="flex justify-center py-16 text-faint">
              <Spinner />
            </div>
          ) : messages.length === 0 ? (
            <Welcome channelId={channelId} />
          ) : (
            messages.map((m, i) => {
              const prev = messages[i - 1];
              const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
              const grouped = !!prev && !newDay && prev.role === m.role && prev.kind === "chat" && m.kind === "chat" && m.createdAt - prev.createdAt < 5 * 60_000;
              return (
                <Fragment key={m.id}>
                  {newDay ? <DayDivider ts={m.createdAt} /> : null}
                  <MessageRow message={m} streamed={state.streaming[m.id]} grouped={grouped} />
                </Fragment>
              );
            })
          )}
          {typing?.active ? <Typing label={typing.label} /> : null}
        </div>
      </div>

      <Composer channelId={channelId} busy={!!typing?.active} onSent={() => (stick.current = true)} />

      <Sheet open={switcher} onClose={() => setSwitcher(false)} title="Channels">
        <div className="p-3">
          {state.channels
            .filter((c) => !c.archived)
            .map((c) => (
              <button
                key={c.id}
                onClick={() => {
                  setSwitcher(false);
                  navigate({ view: null, channel: c.id === "main" ? null : c.id });
                }}
                className={clsx("flex h-11 w-full items-center gap-2 rounded-xl px-3 text-left", c.id === channelId ? "bg-card font-medium" : "text-muted")}
              >
                {c.id === "main" ? <span className="size-4" /> : <Hash size={15} />}
                {c.id === "main" ? "Main thread" : c.name}
                {c.unread ? <span className="ml-auto size-2 rounded-full bg-agent" /> : null}
              </button>
            ))}
          <NewChannelInline onDone={() => setSwitcher(false)} />
        </div>
      </Sheet>
    </div>
  );
}

function NewChannelInline({ onDone }: { onDone: () => void }) {
  const { refresh } = useStore();
  const [name, setName] = useState("");
  return (
    <form
      className="mt-2 flex gap-2 border-t border-line pt-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        const ch = await api.createChannel(name.trim());
        await refresh();
        onDone();
        navigate({ view: null, channel: ch.id });
      }}
    >
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New channel…" className="h-10 flex-1 rounded-xl border border-line bg-card px-3 text-sm outline-none focus:border-agent" />
    </form>
  );
}

function DayDivider({ ts }: { ts: number }) {
  return (
    <div className="my-5 flex items-center gap-3 text-[11.5px] font-medium uppercase tracking-[0.08em] text-faint">
      <span className="h-px flex-1 bg-line" />
      {dayLabel(ts)}
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

const SUGGESTIONS = [
  "What's on my plate today?",
  "Find invoices that are overdue and draft polite follow-ups",
  "Every Friday at 4pm, summarize what I got done this week",
  "Research three competitors and make me a comparison table",
];

function Welcome({ channelId }: { channelId: string }) {
  const { state } = useStore();
  const [name, setName] = useState("");
  const [needsModel, setNeedsModel] = useState(false);
  useEffect(() => {
    api.me().then((m) => setName(m.userName)).catch(() => {});
    api
      .providers()
      .then((p) => setNeedsModel(!p.providers.some((x) => x.enabled && p.keyPresent[x.id])))
      .catch(() => {});
  }, []);
  const noApps = Object.keys(state.connectors).length === 0;
  if (channelId !== "main")
    return (
      <div className="py-16 text-center text-sm text-muted">
        This channel shares memory with the main thread. Keep a topic here so it doesn't crowd everything else.
      </div>
    );
  return (
    <div className="animate-rise py-10 md:py-16">
      <h2 className="font-display text-[28px] font-semibold leading-tight tracking-tight md:text-[34px]">{greeting(name)}.</h2>
      <p className="mt-2 max-w-lg text-[15px] leading-relaxed text-muted">
        Hand me anything you'd give a sharp assistant. I'll check in through the day, run longer jobs as tasks, and ask before I send, pay, sign or delete anything.
      </p>
      {needsModel ? (
        <button
          onClick={() => navigate({ view: "settings", section: "models" })}
          className="mt-6 flex w-full items-center gap-3 rounded-2xl border border-accent/40 bg-accent-soft/60 px-4 py-3 text-left"
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-accent text-white">1</span>
          <span>
            <span className="block text-[14.5px] font-medium">Add a model to get started</span>
            <span className="block text-[13px] text-muted">Paste an Anthropic, OpenAI, Gemini or OpenRouter key — or point Tandem at Ollama for fully local.</span>
          </span>
        </button>
      ) : null}
      <div className="mt-6 grid gap-2 sm:grid-cols-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            onClick={() => void api.send("main", s)}
            className="rounded-2xl border border-line bg-card px-4 py-3 text-left text-[14px] leading-snug text-ink transition hover:border-agent/40 hover:shadow-sm"
          >
            {s}
          </button>
        ))}
      </div>
      {noApps ? (
        <button onClick={() => navigate({ view: "settings", section: "connectors" })} className="mt-6 text-sm text-agent underline underline-offset-2">
          Connect your email and calendar so I can keep an eye on things →
        </button>
      ) : null}
    </div>
  );
}

function MessageRow({ message: m, streamed, grouped }: { message: Message; streamed?: string; grouped: boolean }) {
  const { state } = useStore();
  if (m.kind === "approval" && m.approvalId) {
    const ap = state.approvals[m.approvalId];
    return <div className="animate-rise my-3">{ap ? <ApprovalCard approval={ap} /> : <div className="text-sm text-faint">{m.content}</div>}</div>;
  }
  if (m.kind === "system" || m.role === "system") {
    return (
      <div className="my-3 flex justify-center">
        <div className="max-w-[90%] rounded-2xl bg-sunk px-3 py-1.5 text-center text-[12.5px] text-muted">
          <SystemText text={m.content} />
        </div>
      </div>
    );
  }
  if (m.role === "user") {
    return (
      <div className={clsx("animate-rise flex justify-end", grouped ? "mt-1" : "mt-4")}>
        <div className="max-w-[85%] whitespace-pre-wrap rounded-[20px] rounded-br-md bg-ink px-4 py-2.5 text-[15px] leading-relaxed text-paper">{m.content}</div>
      </div>
    );
  }

  const text = m.content || streamed || "";
  const card = m.kind === "brief" || m.kind === "alert" || m.kind === "task_update";
  const body = (
    <>
      {m.toolCalls.length ? <ToolChips calls={m.toolCalls} /> : null}
      {text ? <Markdown className="text-[15px] text-ink">{text}</Markdown> : !m.toolCalls.length ? <Typing inline /> : null}
      {streamed && !m.content ? <span className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-pulse bg-agent" /> : null}
      {m.artifactIds.length ? <ArtifactChips ids={m.artifactIds} /> : null}
    </>
  );

  if (card) {
    const meta = {
      brief: { icon: <Sun size={14} />, label: "Morning brief", cls: "border-accent/30" },
      alert: { icon: <Bell size={14} />, label: "Heads up", cls: "border-agent/30" },
      task_update: { icon: <CheckSquare size={14} />, label: "Task update", cls: "border-line" },
    }[m.kind as "brief" | "alert" | "task_update"];
    return (
      <div className={clsx("animate-rise my-4 rounded-2xl border bg-card px-4 py-3.5 md:px-5", meta.cls)}>
        <div className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[0.07em] text-muted">
          {meta.icon}
          {meta.label}
          <span className="ml-auto font-normal normal-case tracking-normal text-faint">{clock(m.createdAt)}</span>
        </div>
        {body}
        {m.taskId ? (
          <button onClick={() => navigate({ task: m.taskId })} className="mt-3 text-[13px] font-medium text-agent hover:underline">
            Open task →
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className={clsx("animate-rise group flex gap-3", grouped ? "mt-2" : "mt-5")}>
      <div className="w-7 shrink-0 pt-0.5">{grouped ? null : <AgentMark />}</div>
      <div className="min-w-0 flex-1">
        {grouped ? null : (
          <div className="mb-1 flex items-baseline gap-2">
            <span className="text-[13px] font-semibold text-agent">Tandem</span>
            <span className="text-[11.5px] text-faint">{clock(m.createdAt)}</span>
          </div>
        )}
        {body}
      </div>
    </div>
  );
}

/** System notes may carry a fenced tool result for the model; show it folded. */
function SystemText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const m = text.match(/<untrusted_content[^>]*>([\s\S]*?)<\/untrusted_content>/);
  const head = text.replace(/<untrusted_content[\s\S]*?<\/untrusted_content>/g, "").replace(/<\/?system_note>/g, "").trim();
  return (
    <>
      {head}
      {m?.[1]?.trim() ? (
        <>
          {" "}
          <button onClick={() => setOpen((o) => !o)} className="text-faint underline underline-offset-2 hover:text-muted">
            {open ? "hide result" : "result"}
          </button>
          {open ? <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg bg-paper p-2 text-left font-mono text-[11.5px]">{m[1].trim()}</pre> : null}
        </>
      ) : null}
    </>
  );
}

export function AgentMark({ size = 28 }: { size?: number }) {
  return (
    <div className="grid place-items-center rounded-full bg-agent text-paper" style={{ width: size, height: size }}>
      <svg viewBox="0 0 24 24" width={size * 0.58} height={size * 0.58} fill="none" stroke="currentColor" strokeWidth="2.2">
        <circle cx="9" cy="12" r="5.2" />
        <circle cx="15" cy="12" r="5.2" opacity="0.7" />
      </svg>
    </div>
  );
}

const TOOL_STATUS: Record<ToolCallView["status"], { cls: string; icon?: React.ReactNode }> = {
  running: { cls: "text-muted", icon: <Loader2 size={12} className="animate-spin" /> },
  ok: { cls: "text-muted" },
  error: { cls: "text-danger", icon: <CircleAlert size={12} /> },
  pending_approval: { cls: "text-accent", icon: <Bell size={12} /> },
  denied: { cls: "text-faint line-through" },
  blocked: { cls: "text-danger", icon: <CircleAlert size={12} /> },
};

function ToolChips({ calls }: { calls: ToolCallView[] }) {
  const [open, setOpen] = useState(false);
  const shown = open ? calls : calls.slice(-3);
  const hidden = calls.length - shown.length;
  return (
    <div className="mb-2 flex flex-col gap-1">
      {hidden > 0 ? (
        <button onClick={() => setOpen(true)} className="w-fit text-[12px] text-faint hover:text-muted">
          + {hidden} earlier step{hidden === 1 ? "" : "s"}
        </button>
      ) : null}
      {shown.map((c) => {
        const s = TOOL_STATUS[c.status];
        return (
          <div key={c.id} className={clsx("flex w-fit max-w-full items-center gap-1.5 rounded-full bg-sunk px-2.5 py-1 text-[12.5px]", s.cls)} title={c.name}>
            {s.icon ?? <Wrench size={11} className="opacity-60" />}
            <span className="truncate">{c.summary}</span>
          </div>
        );
      })}
    </div>
  );
}

function ArtifactChips({ ids }: { ids: string[] }) {
  const { state } = useStore();
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {ids.map((id) => {
        const a = state.artifacts[id];
        return (
          <button
            key={id}
            onClick={() => navigate({ view: "make", artifact: id })}
            className="flex items-center gap-2 rounded-xl border border-line bg-card px-3 py-2 text-left text-[13.5px] transition hover:border-agent/40"
          >
            <FileText size={15} className="text-agent" />
            <span className="max-w-[240px] truncate font-medium">{a?.title ?? "Artifact"}</span>
            {a ? <span className="text-xs uppercase text-faint">{a.kind}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

function Typing({ label, inline }: { label?: string; inline?: boolean }) {
  return (
    <div className={clsx("flex items-center gap-3 text-[13px] text-muted", inline ? "" : "mt-5")}>
      {inline ? null : <AgentMark />}
      <span className="dot-breathe flex gap-1">
        <span className="size-1.5 rounded-full bg-agent" />
        <span className="size-1.5 rounded-full bg-agent [animation-delay:0.2s]" />
        <span className="size-1.5 rounded-full bg-agent [animation-delay:0.4s]" />
      </span>
      {label && !inline ? <span>{label}</span> : null}
    </div>
  );
}

type SpeechRec = { start(): void; stop(): void; onresult: ((e: any) => void) | null; onend: (() => void) | null; interimResults: boolean; continuous: boolean; lang: string };

function Composer({ channelId, busy, onSent }: { channelId: string; busy: boolean; onSent: () => void }) {
  const key = `tandem:draft:${channelId}`;
  const [text, setText] = useState(() => sessionStorage.getItem(key) ?? "");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const rec = useRef<SpeechRec | null>(null);
  const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;

  useEffect(() => {
    setText(sessionStorage.getItem(key) ?? "");
  }, [key]);
  useEffect(() => {
    if (text) sessionStorage.setItem(key, text);
    else sessionStorage.removeItem(key);
    const el = ref.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
    }
  }, [text, key]);

  async function send() {
    const content = text.trim();
    if (!content || sending) return;
    setSending(true);
    setError(null);
    rec.current?.stop();
    try {
      await api.send(channelId, content);
      setText("");
      onSent();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
      ref.current?.focus();
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia("(hover: hover)").matches) {
      e.preventDefault();
      void send();
    }
  }

  function toggleVoice() {
    if (listening) {
      rec.current?.stop();
      return;
    }
    const r: SpeechRec = new SR();
    r.interimResults = true;
    r.continuous = true;
    r.lang = navigator.language;
    const base = text ? `${text.trimEnd()} ` : "";
    r.onresult = (e: any) => {
      let s = "";
      for (let i = 0; i < e.results.length; i++) s += e.results[i][0].transcript;
      setText(base + s);
    };
    r.onend = () => setListening(false);
    rec.current = r;
    r.start();
    setListening(true);
  }

  return (
    <div className="shrink-0 px-3 pb-3 pt-1 md:px-6 md:pb-5">
      <div className="mx-auto max-w-[760px]">
        {error ? <p className="mb-1.5 px-2 text-[13px] text-danger">{error}</p> : null}
        <div className="flex items-end gap-1.5 rounded-[26px] border border-line bg-card p-1.5 pl-4 shadow-[0_6px_24px_-18px_rgba(0,0,0,0.35)] focus-within:border-agent/50">
          <textarea
            ref={ref}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            placeholder={busy ? "Add to what Tandem is doing…" : "Message Tandem"}
            className="max-h-[220px] min-h-[40px] flex-1 resize-none bg-transparent py-2 text-[15px] leading-relaxed text-ink outline-none placeholder:text-faint"
          />
          {SR ? (
            <IconButton label={listening ? "Stop dictation" : "Dictate"} onClick={toggleVoice} className={clsx(listening && "bg-accent-soft text-accent")}>
              {listening ? <MicOff size={18} /> : <Mic size={18} />}
            </IconButton>
          ) : null}
          {busy && !text.trim() ? (
            <IconButton label="Stop" onClick={() => void api.stop(channelId)} className="bg-sunk text-ink">
              <Square size={14} fill="currentColor" />
            </IconButton>
          ) : (
            <button
              onClick={() => void send()}
              disabled={!text.trim() || sending}
              aria-label="Send"
              className="grid size-9 place-items-center rounded-full bg-ink text-paper transition active:scale-95 disabled:opacity-25"
            >
              {sending ? <Spinner /> : <ArrowUp size={18} strokeWidth={2.4} />}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
