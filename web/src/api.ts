import type {
  ActivityEntry,
  Approval,
  Artifact,
  CatalogEntry,
  Channel,
  ConnectorConfig,
  ConnectorStatus,
  Memory,
  Message,
  ProviderConfig,
  Routine,
  Settings,
  SkillInfo,
  Task,
  UsageSummary,
} from "@shared";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  if (res.status === 401 && !path.startsWith("/login") && !path.startsWith("/me")) onUnauthorized();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as any).error ?? res.statusText, res.status);
  return data as T;
}

const get = <T,>(p: string) => req<T>("GET", p);
const post = <T,>(p: string, b: unknown = {}) => req<T>("POST", p, b);
const put = <T,>(p: string, b: unknown) => req<T>("PUT", p, b);
const patch = <T,>(p: string, b: unknown) => req<T>("PATCH", p, b);
const del = <T,>(p: string) => req<T>("DELETE", p);

export const api = {
  me: () => get<{ authed: boolean; setupRequired: boolean; userName: string }>("/me"),
  setup: (b: { password: string; userName: string; timezone: string; about?: string }) => post<{ ok: true }>("/setup", b),
  login: (password: string) => post<{ ok: true }>("/login", { password }),
  logout: () => post("/logout"),

  channels: () => get<Channel[]>("/channels"),
  createChannel: (name: string, topic?: string) => post<Channel>("/channels", { name, topic }),
  updateChannel: (id: string, b: Partial<Pick<Channel, "name" | "topic" | "archived">>) => patch<Channel>(`/channels/${id}`, b),
  markRead: (id: string) => post(`/channels/${id}/read`),
  messages: (id: string, before?: number) => get<Message[]>(`/channels/${id}/messages?limit=50${before ? `&before=${before}` : ""}`),
  send: (id: string, content: string) => post<{ message: Message }>(`/channels/${id}/messages`, { content }),
  stop: (id: string) => post(`/channels/${id}/stop`),

  approvals: (status?: string) => get<Approval[]>(`/approvals${status ? `?status=${status}` : ""}`),
  decide: (id: string, decision: "approve" | "deny", edits?: Record<string, unknown>, note?: string) =>
    post<Approval>(`/approvals/${id}`, { decision, edits, note }),

  tasks: () => get<Task[]>("/tasks"),
  task: (id: string) => get<{ task: Task; log: Message[]; question: string | null }>(`/tasks/${id}`),
  createTask: (title: string, brief: string, channelId?: string) => post<Task>("/tasks", { title, brief, channelId }),
  completeTask: (id: string) => post<Task>(`/tasks/${id}/complete`),
  cancelTask: (id: string) => post<Task>(`/tasks/${id}/cancel`),
  replyTask: (id: string, content: string) => post<Task>(`/tasks/${id}/reply`, { content }),

  artifacts: () => get<Artifact[]>("/artifacts"),
  artifact: (id: string) => get<Artifact>(`/artifacts/${id}`),
  saveArtifact: (id: string, b: { title?: string; content: string }) => put<Artifact>(`/artifacts/${id}`, b),
  deleteArtifact: (id: string) => del(`/artifacts/${id}`),

  memories: (q?: string) => get<Memory[]>(`/memories${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  addMemory: (content: string, pinned = false) => post<Memory>("/memories", { content, pinned }),
  updateMemory: (id: string, b: Partial<Pick<Memory, "content" | "pinned" | "tags">>) => patch<Memory>(`/memories/${id}`, b),
  deleteMemory: (id: string) => del(`/memories/${id}`),

  activity: (before?: number) => get<ActivityEntry[]>(`/activity?limit=100${before ? `&before=${before}` : ""}`),
  routines: () => get<Routine[]>("/routines"),
  createRoutine: (b: { name: string; cron: string; prompt: string; channelId?: string }) => post<Routine>("/routines", b),
  updateRoutine: (id: string, b: Partial<Pick<Routine, "name" | "cron" | "prompt" | "enabled">>) => patch<Routine>(`/routines/${id}`, b),
  deleteRoutine: (id: string) => del(`/routines/${id}`),
  runRoutine: (id: string) => post(`/routines/${id}/run`),
  runBrief: () => post("/run/brief"),
  runCheckin: () => post("/run/checkin"),

  settings: () => get<Settings>("/settings"),
  saveSettings: (b: DeepPartial<Settings>) => patch<Settings>("/settings", b),
  providers: () => get<{ providers: ProviderConfig[]; presets: ProviderConfig[]; keyPresent: Record<string, boolean> }>("/providers"),
  saveProvider: (p: ProviderConfig) => put<ProviderConfig>(`/providers/${p.id}`, p),
  deleteProvider: (id: string) => del(`/providers/${id}`),
  models: (id: string) => get<{ models: string[]; error?: string }>(`/providers/${id}/models`),
  testModel: (id: string, model: string) => post<{ ok: boolean; latencyMs: number; error?: string; reply?: string }>(`/providers/${id}/test`, { model }),

  connectors: () => get<{ connectors: ConnectorConfig[]; status: ConnectorStatus[]; catalog: CatalogEntry[] }>("/connectors"),
  saveConnector: (c: ConnectorConfig) => put<ConnectorConfig>(`/connectors/${c.id}`, c),
  deleteConnector: (id: string) => del(`/connectors/${id}`),
  reconnect: (id: string) => post<ConnectorStatus>(`/connectors/${id}/reconnect`),

  secrets: () => get<{ name: string; createdAt: number }[]>("/secrets"),
  setSecret: (name: string, value: string) => put(`/secrets/${encodeURIComponent(name)}`, { value }),
  deleteSecret: (name: string) => del(`/secrets/${encodeURIComponent(name)}`),

  skills: () => get<SkillInfo[]>("/skills"),
  usage: () => get<UsageSummary>("/usage"),
  pushKey: () => get<{ publicKey: string }>("/push/key"),
  subscribePush: (sub: PushSubscriptionJSON) => post("/push/subscribe", sub),
  testPush: () => post("/push/test"),
  takeover: (b: { action: "click" | "type" | "key" | "navigate"; x?: number; y?: number; text?: string; url?: string }) => post("/browser/takeover", b),
};

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };
