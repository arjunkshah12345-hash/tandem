// Types shared between the Tandem server and the web client.
// The web app imports these with `import type`, so keep this file free of runtime code
// other than plain constants.

export type Role = "user" | "assistant" | "system";

/** A channel is a conversation lane. "main" always exists; all channels share memory. */
export interface Channel {
  id: string;
  name: string;
  topic: string | null;
  createdAt: number;
  archived: boolean;
  unread: number;
}

export type MessageKind =
  | "chat" // ordinary conversation
  | "brief" // morning brief
  | "alert" // proactive check-in finding
  | "task_update" // background task finished / needs input
  | "approval" // an approval card (see approvalId)
  | "system"; // housekeeping notices

export interface ToolCallView {
  id: string;
  name: string;
  /** Human-readable one-liner, e.g. "Searched Gmail for 'invoice'". */
  summary: string;
  status: "running" | "ok" | "error" | "pending_approval" | "denied" | "blocked";
}

export interface Message {
  id: string;
  channelId: string;
  role: Role;
  kind: MessageKind;
  /** Markdown. */
  content: string;
  createdAt: number;
  taskId: string | null;
  approvalId: string | null;
  artifactIds: string[];
  toolCalls: ToolCallView[];
  /** Provider:model that produced this message, for assistant messages. */
  model: string | null;
}

export type RiskLevel =
  | "read" // look, search, fetch
  | "internal" // memory, artifacts, tasks, drafts — nothing leaves Tandem
  | "external" // sends/posts/creates something other people can see
  | "payment"
  | "sign"
  | "delete"
  | "forbidden"; // never allowed, even with approval

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "executed" | "failed";

export interface Approval {
  id: string;
  channelId: string;
  taskId: string | null;
  toolName: string;
  risk: RiskLevel;
  /** Plain-language description of exactly what will happen. */
  title: string;
  /** Preview of the payload (e.g. email body), already redacted for display. */
  preview: string;
  args: Record<string, unknown>;
  /** Findings from the sensitive-data scanner or action reviewer, if any. */
  warnings: string[];
  status: ApprovalStatus;
  createdAt: number;
  decidedAt: number | null;
  result: string | null;
}

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_input"
  | "waiting_approval"
  | "suggested_done" // agent thinks it's finished; only the user can mark it completed
  | "completed"
  | "failed"
  | "cancelled";

export interface Task {
  id: string;
  channelId: string;
  title: string;
  brief: string;
  status: TaskStatus;
  progress: string | null;
  createdAt: number;
  updatedAt: number;
  artifactIds: string[];
  /** Number of agent steps taken so far. */
  steps: number;
}

export type ArtifactKind = "markdown" | "html" | "csv" | "json" | "code" | "text";

export interface Artifact {
  id: string;
  title: string;
  kind: ArtifactKind;
  /** Only present when fetching a single artifact. */
  content?: string;
  taskId: string | null;
  createdAt: number;
  updatedAt: number;
  version: number;
}

export interface Memory {
  id: string;
  content: string;
  tags: string[];
  pinned: boolean;
  source: string | null;
  createdAt: number;
}

export interface ActivityEntry {
  id: string;
  at: number;
  kind: "tool" | "approval" | "checkin" | "brief" | "routine" | "task" | "error" | "notify" | "system";
  summary: string;
  detail: string | null;
  channelId: string | null;
  taskId: string | null;
}

export interface Routine {
  id: string;
  name: string;
  /** Cron expression (5 or 6 fields) in the user's timezone. */
  cron: string;
  prompt: string;
  channelId: string;
  enabled: boolean;
  lastRunAt: number | null;
  nextRunAt: number | null;
}

export type ProviderKind = "anthropic" | "openai" | "gemini";

export interface ProviderConfig {
  id: string; // e.g. "anthropic", "openrouter", "ollama"
  kind: ProviderKind; // wire protocol
  label: string;
  baseUrl: string;
  /** Name of the vault secret holding the API key (never the key itself). */
  apiKeySecret: string | null;
  enabled: boolean;
  extraHeaders?: Record<string, string>;
}

/** A model reference is "providerId:modelId", e.g. "anthropic:claude-opus-5-5". */
export type ModelRef = string;

export interface ConnectorConfig {
  id: string;
  name: string;
  type: "mcp-stdio" | "mcp-http" | "email" | "calendar-ics";
  enabled: boolean;
  /** mcp-stdio */
  command?: string;
  args?: string[];
  env?: Record<string, string>; // values may contain {{secret:NAME}}
  /** mcp-http */
  url?: string;
  headers?: Record<string, string>; // values may contain {{secret:NAME}}
  /** email: IMAP/SMTP */
  email?: {
    address: string;
    imapHost: string;
    imapPort: number;
    smtpHost: string;
    smtpPort: number;
    username: string;
    passwordSecret: string;
  };
  /** calendar-ics */
  icsUrlSecret?: string;
  /** Per-tool risk overrides, keyed by the server's tool name (without connector prefix). */
  riskOverrides?: Record<string, RiskLevel>;
  /** Tools to hide from the agent entirely. */
  disabledTools?: string[];
}

export interface ConnectorStatus {
  id: string;
  state: "connected" | "connecting" | "error" | "disabled" | "needs_auth";
  error: string | null;
  tools: { name: string; description: string; risk: RiskLevel }[];
  authUrl?: string | null;
}

export interface NotifyConfig {
  webPush: boolean;
  ntfy: { enabled: boolean; server: string; topic: string } | null;
  telegram: { enabled: boolean; botTokenSecret: string; chatId: string | null } | null;
  webhook: { enabled: boolean; url: string } | null;
}

export interface Settings {
  /** IANA timezone, e.g. "America/Los_Angeles". */
  timezone: string;
  userName: string;
  /** Free-text "about my work" that seeds the agent's understanding. */
  about: string;
  models: {
    /** Heavy lifting: tasks, briefs, chat. */
    work: ModelRef;
    /** Cheap, frequent: check-in triage, summarisation, classification. */
    triage: ModelRef;
    /** Tried in order if the primary model fails. */
    fallbacks: ModelRef[];
  };
  brief: { enabled: boolean; time: string /* "07:30" */; weekdaysOnly: boolean };
  checkins: {
    enabled: boolean;
    everyHours: number;
    activeFrom: string; // "08:00"
    activeTo: string; // "20:00"
  };
  quietHours: { enabled: boolean; from: string; to: string };
  budget: {
    /** Hard cap on estimated USD spend per day for *background* work. 0 = unlimited. */
    dailyBackgroundUsd: number;
    /** Hard cap per task run. 0 = unlimited. */
    perTaskUsd: number;
  };
  safety: {
    /** Require approval for these risk levels. "forbidden" is always blocked. */
    approvalRequired: RiskLevel[];
    /** Block outbound payloads containing card numbers / government IDs / secrets. */
    blockSensitiveData: boolean;
    /** Run an LLM reviewer on every action that needs approval and attach its concerns. */
    actionReviewer: boolean;
    /** Max spend per single payment approval, USD. */
    maxPaymentUsd: number;
  };
  notify: NotifyConfig;
  browser: { enabled: boolean; headless: boolean; executablePath: string | null };
  sandbox: { enabled: boolean; image: string };
}

export interface UsageSummary {
  today: { inputTokens: number; outputTokens: number; usd: number; backgroundUsd: number };
  last30: { day: string; usd: number; background: number }[];
  byModel: { model: string; usd: number; calls: number }[];
}

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  builtin: boolean;
}

/** Server -> client events over GET /api/events (SSE). */
export type ServerEvent =
  | { type: "message"; message: Message }
  | { type: "message_delta"; messageId: string; channelId: string; delta: string }
  | { type: "message_update"; message: Message }
  | { type: "typing"; channelId: string; active: boolean; label?: string }
  | { type: "approval"; approval: Approval }
  | { type: "task"; task: Task }
  | { type: "artifact"; artifact: Artifact }
  | { type: "activity"; entry: ActivityEntry }
  | { type: "channel"; channel: Channel }
  | { type: "connector"; status: ConnectorStatus }
  | { type: "browser_frame"; image: string /* data URL */; url: string; title: string; at: number };

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  template: Omit<ConnectorConfig, "id" | "enabled">;
  /** Secrets the user must provide, e.g. ["STRIPE_API_KEY"]. */
  secrets: { name: string; label: string; help?: string }[];
  docsUrl?: string;
}

export const DEFAULT_APPROVAL_RISKS: RiskLevel[] = ["external", "payment", "sign", "delete"];
