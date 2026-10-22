import type {
  ActivityEntry,
  Approval,
  ApprovalStatus,
  Artifact,
  ArtifactKind,
  Channel,
  Memory,
  Message,
  MessageKind,
  Role,
  Routine,
  Task,
  TaskStatus,
  ToolCallView,
} from "./shared.ts";
import type { DB } from "./db.ts";
import { ftsQuery } from "./db.ts";
import { bus } from "./bus.ts";
import { id, now, safeJson } from "./util.ts";
import type { LlmMessage } from "./providers/types.ts";

export class Store {
  constructor(public db: DB) {
    if (!this.getChannel("main")) {
      db.prepare("INSERT INTO channels (id, name, topic, created_at) VALUES ('main', 'Main', NULL, ?)").run(now());
    }
  }

  // ---------- channels ----------
  listChannels(): Channel[] {
    const rows = this.db.prepare("SELECT * FROM channels ORDER BY id = 'main' DESC, created_at").all() as any[];
    return rows.map((r) => this.channelRow(r));
  }
  getChannel(cid: string): Channel | null {
    const r = this.db.prepare("SELECT * FROM channels WHERE id = ?").get(cid) as any;
    return r ? this.channelRow(r) : null;
  }
  private channelRow(r: any): Channel {
    const unread = (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND role = 'assistant' AND created_at > ? AND task_id IS NULL")
        .get(r.id, r.last_read_at) as { n: number }
    ).n;
    return { id: r.id, name: r.name, topic: r.topic, createdAt: r.created_at, archived: !!r.archived, unread };
  }
  createChannel(name: string, topic: string | null = null): Channel {
    const cid = id("ch");
    this.db.prepare("INSERT INTO channels (id, name, topic, created_at, last_read_at) VALUES (?,?,?,?,?)").run(cid, name, topic, now(), now());
    const c = this.getChannel(cid)!;
    bus.emitEvent({ type: "channel", channel: c });
    return c;
  }
  updateChannel(cid: string, patch: { name?: string; topic?: string | null; archived?: boolean }): Channel {
    const c = this.getChannel(cid);
    if (!c) throw new Error("channel not found");
    if (cid === "main" && patch.archived) throw new Error("The main thread can't be archived");
    this.db
      .prepare("UPDATE channels SET name = ?, topic = ?, archived = ? WHERE id = ?")
      .run(patch.name ?? c.name, patch.topic === undefined ? c.topic : patch.topic, (patch.archived ?? c.archived) ? 1 : 0, cid);
    const n = this.getChannel(cid)!;
    bus.emitEvent({ type: "channel", channel: n });
    return n;
  }
  markRead(cid: string) {
    this.db.prepare("UPDATE channels SET last_read_at = ? WHERE id = ?").run(now(), cid);
    const c = this.getChannel(cid);
    if (c) bus.emitEvent({ type: "channel", channel: c });
  }
  getSummary(cid: string): { summary: string | null; upto: number } {
    const r = this.db.prepare("SELECT summary, summary_upto FROM channels WHERE id = ?").get(cid) as any;
    return { summary: r?.summary ?? null, upto: r?.summary_upto ?? 0 };
  }
  setSummary(cid: string, summary: string, upto: number) {
    this.db.prepare("UPDATE channels SET summary = ?, summary_upto = ? WHERE id = ?").run(summary, upto, cid);
  }

  // ---------- messages ----------
  addMessage(m: {
    channelId: string;
    role: Role;
    kind?: MessageKind;
    content: string;
    taskId?: string | null;
    approvalId?: string | null;
    artifactIds?: string[];
    toolCalls?: ToolCallView[];
    model?: string | null;
    transcript?: LlmMessage[] | null;
    emit?: boolean;
  }): Message {
    const msg: Message = {
      id: id("msg"),
      channelId: m.channelId,
      role: m.role,
      kind: m.kind ?? "chat",
      content: m.content,
      createdAt: now(),
      taskId: m.taskId ?? null,
      approvalId: m.approvalId ?? null,
      artifactIds: m.artifactIds ?? [],
      toolCalls: m.toolCalls ?? [],
      model: m.model ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO messages (id, channel_id, role, kind, content, created_at, task_id, approval_id, artifact_ids, tool_calls, model, transcript)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        msg.id,
        msg.channelId,
        msg.role,
        msg.kind,
        msg.content,
        msg.createdAt,
        msg.taskId,
        msg.approvalId,
        JSON.stringify(msg.artifactIds),
        JSON.stringify(msg.toolCalls),
        msg.model,
        m.transcript ? JSON.stringify(m.transcript) : null,
      );
    if (m.emit !== false) bus.emitEvent({ type: "message", message: msg });
    return msg;
  }
  updateMessage(
    mid: string,
    patch: Partial<Pick<Message, "content" | "toolCalls" | "artifactIds" | "model">> & { transcript?: LlmMessage[] },
  ): Message | null {
    const cur = this.getMessage(mid);
    if (!cur) return null;
    const { transcript, ...rest } = patch;
    const next = { ...cur, ...rest };
    this.db
      .prepare("UPDATE messages SET content = ?, tool_calls = ?, artifact_ids = ?, model = ? WHERE id = ?")
      .run(next.content, JSON.stringify(next.toolCalls), JSON.stringify(next.artifactIds), next.model, mid);
    if (transcript) this.db.prepare("UPDATE messages SET transcript = ? WHERE id = ?").run(JSON.stringify(transcript), mid);
    bus.emitEvent({ type: "message_update", message: next });
    return next;
  }
  getMessage(mid: string): Message | null {
    const r = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(mid) as any;
    return r ? this.msgRow(r) : null;
  }
  /** Channel timeline (task-internal log messages excluded). */
  listMessages(cid: string, opts: { before?: number; limit?: number } = {}): Message[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE channel_id = ? AND created_at < ? AND (task_id IS NULL OR kind != 'chat')
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(cid, opts.before ?? Number.MAX_SAFE_INTEGER, Math.min(opts.limit ?? 50, 200)) as any[];
    return rows.reverse().map((r) => this.msgRow(r));
  }
  /** Messages with their stored model transcripts, for building context. */
  historyForContext(cid: string, after: number, limit: number): { msg: Message; transcript: LlmMessage[] | null }[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE channel_id = ? AND created_at > ? AND (task_id IS NULL OR kind != 'chat')
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(cid, after, limit) as any[];
    return rows.reverse().map((r) => ({ msg: this.msgRow(r), transcript: safeJson<LlmMessage[] | null>(r.transcript, null) }));
  }
  searchMessages(q: string, limit = 10): Message[] {
    const fq = ftsQuery(q);
    if (!fq) return [];
    const rows = this.db
      .prepare(`SELECT m.* FROM messages_fts f JOIN messages m ON m.rowid = f.rowid WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?`)
      .all(fq, limit) as any[];
    return rows.map((r) => this.msgRow(r));
  }
  private msgRow(r: any): Message {
    return {
      id: r.id,
      channelId: r.channel_id,
      role: r.role,
      kind: r.kind,
      content: r.content,
      createdAt: r.created_at,
      taskId: r.task_id,
      approvalId: r.approval_id,
      artifactIds: safeJson(r.artifact_ids, []),
      toolCalls: safeJson(r.tool_calls, []),
      model: r.model,
    };
  }

  // ---------- approvals ----------
  createApproval(a: Omit<Approval, "id" | "status" | "createdAt" | "decidedAt" | "result"> & { toolCallId?: string }): Approval {
    const ap: Approval = {
      id: id("ap"),
      channelId: a.channelId,
      taskId: a.taskId,
      toolName: a.toolName,
      risk: a.risk,
      title: a.title,
      preview: a.preview,
      args: a.args,
      warnings: a.warnings,
      status: "pending",
      createdAt: now(),
      decidedAt: null,
      result: null,
    };
    this.db
      .prepare(
        `INSERT INTO approvals (id, channel_id, task_id, tool_name, risk, title, preview, args, warnings, status, created_at, tool_call_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        ap.id,
        ap.channelId,
        ap.taskId,
        ap.toolName,
        ap.risk,
        ap.title,
        ap.preview,
        JSON.stringify(ap.args),
        JSON.stringify(ap.warnings),
        ap.status,
        ap.createdAt,
        a.toolCallId ?? null,
      );
    bus.emitEvent({ type: "approval", approval: ap });
    return ap;
  }
  getApproval(aid: string): Approval | null {
    const r = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(aid) as any;
    return r ? this.apRow(r) : null;
  }
  listApprovals(status?: ApprovalStatus): Approval[] {
    const rows = (
      status
        ? this.db.prepare("SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC LIMIT 200").all(status)
        : this.db.prepare("SELECT * FROM approvals ORDER BY created_at DESC LIMIT 200").all()
    ) as any[];
    return rows.map((r) => this.apRow(r));
  }
  /** Atomically move an approval out of `pending`; returns false if someone else already decided it. */
  claimApproval(aid: string, status: "approved" | "denied" | "expired"): boolean {
    const r = this.db.prepare("UPDATE approvals SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'").run(status, now(), aid);
    return Number(r.changes) === 1;
  }
  setApproval(aid: string, patch: { status?: ApprovalStatus; args?: Record<string, unknown>; result?: string | null; preview?: string }) {
    const cur = this.getApproval(aid);
    if (!cur) throw new Error("approval not found");
    this.db
      .prepare("UPDATE approvals SET status = ?, args = ?, result = ?, preview = ? WHERE id = ?")
      .run(
        patch.status ?? cur.status,
        JSON.stringify(patch.args ?? cur.args),
        patch.result === undefined ? cur.result : patch.result,
        patch.preview ?? cur.preview,
        aid,
      );
    const next = this.getApproval(aid)!;
    bus.emitEvent({ type: "approval", approval: next });
    return next;
  }
  private apRow(r: any): Approval {
    return {
      id: r.id,
      channelId: r.channel_id,
      taskId: r.task_id,
      toolName: r.tool_name,
      risk: r.risk,
      title: r.title,
      preview: r.preview,
      args: safeJson(r.args, {}),
      warnings: safeJson(r.warnings, []),
      status: r.status,
      createdAt: r.created_at,
      decidedAt: r.decided_at,
      result: r.result,
    };
  }

  // ---------- tasks ----------
  createTask(t: { channelId: string; title: string; brief: string }): Task {
    const tid = id("task");
    const ts = now();
    this.db
      .prepare("INSERT INTO tasks (id, channel_id, title, brief, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(tid, t.channelId, t.title, t.brief, "queued", ts, ts);
    const task = this.getTask(tid)!;
    bus.emitEvent({ type: "task", task });
    return task;
  }
  getTask(tid: string): Task | null {
    const r = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(tid) as any;
    return r ? this.taskRow(r) : null;
  }
  listTasks(statuses?: TaskStatus[]): Task[] {
    const rows = this.db.prepare("SELECT * FROM tasks ORDER BY updated_at DESC LIMIT 300").all() as any[];
    return rows.map((r) => this.taskRow(r)).filter((t) => !statuses || statuses.includes(t.status));
  }
  updateTask(
    tid: string,
    patch: Partial<Pick<Task, "status" | "progress" | "steps" | "artifactIds" | "title">> & {
      transcript?: LlmMessage[];
      pendingQuestion?: string | null;
    },
  ): Task {
    const cur = this.getTask(tid);
    if (!cur) throw new Error("task not found");
    const { transcript, pendingQuestion, ...rest } = patch;
    const n = { ...cur, ...rest };
    this.db
      .prepare("UPDATE tasks SET status = ?, progress = ?, steps = ?, artifact_ids = ?, title = ?, updated_at = ? WHERE id = ?")
      .run(n.status, n.progress, n.steps, JSON.stringify(n.artifactIds), n.title, now(), tid);
    if (transcript) this.db.prepare("UPDATE tasks SET transcript = ? WHERE id = ?").run(JSON.stringify(transcript), tid);
    if (pendingQuestion !== undefined) this.db.prepare("UPDATE tasks SET pending_question = ? WHERE id = ?").run(pendingQuestion, tid);
    const task = this.getTask(tid)!;
    bus.emitEvent({ type: "task", task });
    return task;
  }
  taskTranscript(tid: string): LlmMessage[] {
    const r = this.db.prepare("SELECT transcript FROM tasks WHERE id = ?").get(tid) as any;
    return safeJson(r?.transcript, []);
  }
  taskPendingQuestion(tid: string): string | null {
    const r = this.db.prepare("SELECT pending_question FROM tasks WHERE id = ?").get(tid) as any;
    return r?.pending_question ?? null;
  }
  taskLog(tid: string): Message[] {
    const rows = this.db.prepare("SELECT * FROM messages WHERE task_id = ? ORDER BY created_at").all(tid) as any[];
    return rows.map((r) => this.msgRow(r));
  }
  private taskRow(r: any): Task {
    return {
      id: r.id,
      channelId: r.channel_id,
      title: r.title,
      brief: r.brief,
      status: r.status,
      progress: r.progress,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      artifactIds: safeJson(r.artifact_ids, []),
      steps: r.steps,
    };
  }

  // ---------- artifacts ----------
  createArtifact(a: { title: string; kind: ArtifactKind; content: string; taskId?: string | null }): Artifact {
    const aid = id("art");
    const ts = now();
    this.db
      .prepare("INSERT INTO artifacts (id, title, kind, content, task_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(aid, a.title, a.kind, a.content, a.taskId ?? null, ts, ts);
    const art = this.getArtifact(aid, false)!;
    bus.emitEvent({ type: "artifact", artifact: art });
    return art;
  }
  updateArtifact(aid: string, patch: { title?: string; content?: string }): Artifact {
    const cur = this.getArtifact(aid, true);
    if (!cur) throw new Error("artifact not found");
    this.db
      .prepare("UPDATE artifacts SET title = ?, content = ?, updated_at = ?, version = version + 1 WHERE id = ?")
      .run(patch.title ?? cur.title, patch.content ?? cur.content!, now(), aid);
    const art = this.getArtifact(aid, false)!;
    bus.emitEvent({ type: "artifact", artifact: art });
    return art;
  }
  getArtifact(aid: string, withContent = true): Artifact | null {
    const r = this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(aid) as any;
    if (!r) return null;
    return {
      id: r.id,
      title: r.title,
      kind: r.kind,
      content: withContent ? r.content : undefined,
      taskId: r.task_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      version: r.version,
    };
  }
  listArtifacts(): Artifact[] {
    const rows = this.db.prepare("SELECT id FROM artifacts ORDER BY updated_at DESC").all() as any[];
    return rows.map((r) => this.getArtifact(r.id, false)!);
  }
  deleteArtifact(aid: string) {
    this.db.prepare("DELETE FROM artifacts WHERE id = ?").run(aid);
  }

  // ---------- memories ----------
  addMemory(content: string, tags: string[] = [], pinned = false, source: string | null = null): Memory {
    const dup = this.db.prepare("SELECT id FROM memories WHERE content = ?").get(content) as any;
    if (dup) return this.getMemory(dup.id)!;
    const mid = id("mem");
    this.db
      .prepare("INSERT INTO memories (id, content, tags, pinned, source, created_at) VALUES (?,?,?,?,?,?)")
      .run(mid, content, JSON.stringify(tags), pinned ? 1 : 0, source, now());
    return this.getMemory(mid)!;
  }
  getMemory(mid: string): Memory | null {
    const r = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(mid) as any;
    return r ? this.memRow(r) : null;
  }
  updateMemory(mid: string, patch: { content?: string; pinned?: boolean; tags?: string[] }): Memory {
    const cur = this.getMemory(mid);
    if (!cur) throw new Error("memory not found");
    this.db
      .prepare("UPDATE memories SET content = ?, pinned = ?, tags = ? WHERE id = ?")
      .run(patch.content ?? cur.content, (patch.pinned ?? cur.pinned) ? 1 : 0, JSON.stringify(patch.tags ?? cur.tags), mid);
    return this.getMemory(mid)!;
  }
  deleteMemory(mid: string) {
    this.db.prepare("DELETE FROM memories WHERE id = ?").run(mid);
  }
  searchMemories(q: string, limit = 8): Memory[] {
    const fq = ftsQuery(q);
    if (!fq) return [];
    const rows = this.db
      .prepare(`SELECT m.* FROM memories_fts f JOIN memories m ON m.rowid = f.rowid WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?`)
      .all(fq, limit) as any[];
    return rows.map((r) => this.memRow(r));
  }
  listMemories(limit = 500): Memory[] {
    return (this.db.prepare("SELECT * FROM memories ORDER BY pinned DESC, created_at DESC LIMIT ?").all(limit) as any[]).map((r) =>
      this.memRow(r),
    );
  }
  pinnedMemories(): Memory[] {
    return (this.db.prepare("SELECT * FROM memories WHERE pinned = 1 ORDER BY created_at").all() as any[]).map((r) => this.memRow(r));
  }
  private memRow(r: any): Memory {
    return { id: r.id, content: r.content, tags: safeJson(r.tags, []), pinned: !!r.pinned, source: r.source, createdAt: r.created_at };
  }

  // ---------- activity ----------
  log(kind: ActivityEntry["kind"], summary: string, detail: string | null = null, channelId: string | null = null, taskId: string | null = null) {
    const e: ActivityEntry = { id: id("act"), at: now(), kind, summary, detail, channelId, taskId };
    this.db
      .prepare("INSERT INTO activity (id, at, kind, summary, detail, channel_id, task_id) VALUES (?,?,?,?,?,?,?)")
      .run(e.id, e.at, e.kind, e.summary, e.detail, e.channelId, e.taskId);
    bus.emitEvent({ type: "activity", entry: e });
    return e;
  }
  listActivity(limit = 100, before = Number.MAX_SAFE_INTEGER): ActivityEntry[] {
    return (this.db.prepare("SELECT * FROM activity WHERE at < ? ORDER BY at DESC LIMIT ?").all(before, Math.min(limit, 500)) as any[]).map(
      (r) => ({
        id: r.id,
        at: r.at,
        kind: r.kind,
        summary: r.summary,
        detail: r.detail,
        channelId: r.channel_id,
        taskId: r.task_id,
      }),
    );
  }

  // ---------- routines ----------
  listRoutines(): Omit<Routine, "nextRunAt">[] {
    return (this.db.prepare("SELECT * FROM routines ORDER BY name").all() as any[]).map((r) => ({
      id: r.id,
      name: r.name,
      cron: r.cron,
      prompt: r.prompt,
      channelId: r.channel_id,
      enabled: !!r.enabled,
      lastRunAt: r.last_run_at,
    }));
  }
  createRoutine(r: { name: string; cron: string; prompt: string; channelId: string }) {
    const rid = id("rt");
    this.db.prepare("INSERT INTO routines (id, name, cron, prompt, channel_id) VALUES (?,?,?,?,?)").run(rid, r.name, r.cron, r.prompt, r.channelId);
    return rid;
  }
  updateRoutine(rid: string, patch: { name?: string; cron?: string; prompt?: string; enabled?: boolean; lastRunAt?: number }) {
    const cur = this.listRoutines().find((r) => r.id === rid);
    if (!cur) throw new Error("routine not found");
    this.db
      .prepare("UPDATE routines SET name = ?, cron = ?, prompt = ?, enabled = ?, last_run_at = ? WHERE id = ?")
      .run(
        patch.name ?? cur.name,
        patch.cron ?? cur.cron,
        patch.prompt ?? cur.prompt,
        (patch.enabled ?? cur.enabled) ? 1 : 0,
        patch.lastRunAt ?? cur.lastRunAt,
        rid,
      );
  }
  deleteRoutine(rid: string) {
    this.db.prepare("DELETE FROM routines WHERE id = ?").run(rid);
  }

  // ---------- seen watermarks ----------
  markSeen(source: string, items: string[]) {
    const st = this.db.prepare("INSERT OR IGNORE INTO seen (source, item, at) VALUES (?,?,?)");
    for (const i of items) st.run(source, i, now());
  }
  unseen(source: string, items: string[]): string[] {
    const st = this.db.prepare("SELECT 1 FROM seen WHERE source = ? AND item = ?");
    return items.filter((i) => !st.get(source, i));
  }
}
