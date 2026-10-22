import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import type { ActivityEntry, Approval, Artifact, Channel, ConnectorStatus, Message, ServerEvent, Task } from "@shared";
import { api } from "./api";

export interface BrowserFrame {
  image: string;
  url: string;
  title: string;
  at: number;
}

interface State {
  connected: boolean;
  channels: Channel[];
  messages: Record<string, Message[]>;
  /** channel → whether older messages may exist */
  hasMore: Record<string, boolean>;
  streaming: Record<string, string>; // messageId → streamed text so far
  typing: Record<string, { active: boolean; label?: string }>;
  approvals: Record<string, Approval>;
  tasks: Record<string, Task>;
  artifacts: Record<string, Artifact>;
  activity: ActivityEntry[];
  connectors: Record<string, ConnectorStatus>;
  browser: BrowserFrame | null;
}

type Action =
  | { type: "event"; e: ServerEvent }
  | { type: "connected"; value: boolean }
  | { type: "channels"; channels: Channel[] }
  | { type: "messages"; channelId: string; messages: Message[]; prepend: boolean; hasMore: boolean }
  | { type: "approvals"; approvals: Approval[] }
  | { type: "tasks"; tasks: Task[] }
  | { type: "artifacts"; artifacts: Artifact[] }
  | { type: "activity"; entries: ActivityEntry[]; append: boolean };

const initial: State = {
  connected: false,
  channels: [],
  messages: {},
  hasMore: {},
  streaming: {},
  typing: {},
  approvals: {},
  tasks: {},
  artifacts: {},
  activity: [],
  connectors: {},
  browser: null,
};

function upsertMessage(list: Message[] | undefined, m: Message): Message[] {
  const cur = list ?? [];
  const i = cur.findIndex((x) => x.id === m.id);
  if (i === -1) return [...cur, m].sort((a, b) => a.createdAt - b.createdAt);
  const next = cur.slice();
  next[i] = m;
  return next;
}

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "connected":
      return { ...s, connected: a.value };
    case "channels":
      return { ...s, channels: a.channels };
    case "messages": {
      const existing = s.messages[a.channelId] ?? [];
      const merged = a.prepend ? [...a.messages, ...existing] : a.messages;
      const seen = new Set<string>();
      const dedup = merged.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
      return { ...s, messages: { ...s.messages, [a.channelId]: dedup }, hasMore: { ...s.hasMore, [a.channelId]: a.hasMore } };
    }
    case "approvals":
      return { ...s, approvals: Object.fromEntries(a.approvals.map((x) => [x.id, x])) };
    case "tasks":
      return { ...s, tasks: Object.fromEntries(a.tasks.map((x) => [x.id, x])) };
    case "artifacts":
      return { ...s, artifacts: Object.fromEntries(a.artifacts.map((x) => [x.id, x])) };
    case "activity":
      return { ...s, activity: a.append ? [...s.activity, ...a.entries] : a.entries };
    case "event": {
      const e = a.e;
      switch (e.type) {
        case "message": {
          // Task work-log entries stay out of the channel timeline.
          if (e.message.taskId && e.message.kind === "chat") return s;
          if (!s.messages[e.message.channelId]) {
            return bumpUnread(s, e.message);
          }
          return bumpUnread({ ...s, messages: { ...s.messages, [e.message.channelId]: upsertMessage(s.messages[e.message.channelId], e.message) } }, e.message);
        }
        case "message_update": {
          if (e.message.taskId && e.message.kind === "chat") return s;
          const streaming = { ...s.streaming };
          if (e.message.content) delete streaming[e.message.id];
          return {
            ...s,
            streaming,
            messages: s.messages[e.message.channelId]
              ? { ...s.messages, [e.message.channelId]: upsertMessage(s.messages[e.message.channelId], e.message) }
              : s.messages,
          };
        }
        case "message_delta":
          return { ...s, streaming: { ...s.streaming, [e.messageId]: (s.streaming[e.messageId] ?? "") + e.delta } };
        case "typing":
          return { ...s, typing: { ...s.typing, [e.channelId]: { active: e.active, label: e.label } } };
        case "approval":
          return { ...s, approvals: { ...s.approvals, [e.approval.id]: e.approval } };
        case "task":
          return { ...s, tasks: { ...s.tasks, [e.task.id]: e.task } };
        case "artifact":
          return { ...s, artifacts: { ...s.artifacts, [e.artifact.id]: e.artifact } };
        case "activity":
          return { ...s, activity: [e.entry, ...s.activity].slice(0, 500) };
        case "channel": {
          const i = s.channels.findIndex((c) => c.id === e.channel.id);
          const channels = i === -1 ? [...s.channels, e.channel] : s.channels.map((c) => (c.id === e.channel.id ? e.channel : c));
          return { ...s, channels };
        }
        case "connector":
          return { ...s, connectors: { ...s.connectors, [e.status.id]: e.status } };
        case "browser_frame":
          return { ...s, browser: { image: e.image, url: e.url, title: e.title, at: e.at } };
      }
    }
  }
  return s;
}

function bumpUnread(s: State, m: Message): State {
  if (m.role !== "assistant") return s;
  return { ...s, channels: s.channels.map((c) => (c.id === m.channelId ? { ...c, unread: c.unread + 1 } : c)) };
}

interface Ctx {
  state: State;
  loadMessages: (channelId: string, older?: boolean) => Promise<void>;
  refresh: () => Promise<void>;
  loadActivity: (older?: boolean) => Promise<void>;
  markRead: (channelId: string) => void;
}

const StoreCtx = createContext<Ctx | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);
  const stateRef = useRef(state);
  stateRef.current = state;

  const refresh = useCallback(async () => {
    const [channels, approvals, tasks, artifacts] = await Promise.all([api.channels(), api.approvals(), api.tasks(), api.artifacts()]);
    dispatch({ type: "channels", channels });
    dispatch({ type: "approvals", approvals });
    dispatch({ type: "tasks", tasks });
    dispatch({ type: "artifacts", artifacts });
  }, []);

  const loadMessages = useCallback(async (channelId: string, older = false) => {
    const cur = stateRef.current.messages[channelId];
    const before = older && cur?.length ? cur[0].createdAt : undefined;
    const msgs = await api.messages(channelId, before);
    dispatch({ type: "messages", channelId, messages: msgs, prepend: older, hasMore: msgs.length >= 50 });
  }, []);

  const loadActivity = useCallback(async (older = false) => {
    const cur = stateRef.current.activity;
    const entries = await api.activity(older && cur.length ? cur[cur.length - 1].at : undefined);
    dispatch({ type: "activity", entries, append: older });
  }, []);

  const markRead = useCallback((channelId: string) => {
    const ch = stateRef.current.channels.find((c) => c.id === channelId);
    if (ch && ch.unread > 0) {
      dispatch({ type: "event", e: { type: "channel", channel: { ...ch, unread: 0 } } });
      void api.markRead(channelId);
    }
  }, []);

  // Live events with auto-reconnect; on reconnect, resync anything we may have missed.
  useEffect(() => {
    let es: EventSource | null = null;
    let retry = 1000;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    const open = () => {
      es = new EventSource("/api/events");
      es.addEventListener("hello", () => {
        retry = 1000;
        dispatch({ type: "connected", value: true });
        void refresh();
        for (const id of Object.keys(stateRef.current.messages)) void loadMessages(id);
      });
      es.onmessage = (m) => {
        try {
          dispatch({ type: "event", e: JSON.parse(m.data) });
        } catch {}
      };
      es.onerror = () => {
        dispatch({ type: "connected", value: false });
        es?.close();
        if (closed) return;
        timer = setTimeout(open, retry);
        retry = Math.min(retry * 2, 15000);
      };
    };
    open();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      es?.close();
    };
  }, [refresh, loadMessages]);

  const value = useMemo(() => ({ state, loadMessages, refresh, loadActivity, markRead }), [state, loadMessages, refresh, loadActivity, markRead]);
  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

export function useStore() {
  const c = useContext(StoreCtx);
  if (!c) throw new Error("useStore outside provider");
  return c;
}

export function usePendingApprovals() {
  const { state } = useStore();
  return Object.values(state.approvals)
    .filter((a) => a.status === "pending")
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function useNeedsYouTasks() {
  const { state } = useStore();
  return Object.values(state.tasks)
    .filter((t) => t.status === "waiting_input" || t.status === "suggested_done" || t.status === "waiting_approval")
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
