import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const MIGRATIONS: string[] = [
  `
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE channels (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, topic TEXT, created_at INTEGER NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0, last_read_at INTEGER NOT NULL DEFAULT 0,
    summary TEXT, summary_upto INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE messages (
    id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL,
    content TEXT NOT NULL, created_at INTEGER NOT NULL, task_id TEXT, approval_id TEXT,
    artifact_ids TEXT NOT NULL DEFAULT '[]', tool_calls TEXT NOT NULL DEFAULT '[]', model TEXT,
    -- provider-neutral transcript blocks for replaying context to the model
    transcript TEXT
  );
  CREATE INDEX messages_channel ON messages(channel_id, created_at);
  CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='rowid');
  CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
  END;
  CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  END;
  CREATE TRIGGER messages_au AFTER UPDATE OF content ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
  END;

  CREATE TABLE memories (
    id TEXT PRIMARY KEY, content TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
    pinned INTEGER NOT NULL DEFAULT 0, source TEXT, created_at INTEGER NOT NULL
  );
  CREATE VIRTUAL TABLE memories_fts USING fts5(content, tags, content='memories', content_rowid='rowid');
  CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
  END;
  CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags);
  END;
  CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags);
    INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
  END;

  CREATE TABLE approvals (
    id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, task_id TEXT, tool_name TEXT NOT NULL,
    risk TEXT NOT NULL, title TEXT NOT NULL, preview TEXT NOT NULL, args TEXT NOT NULL,
    warnings TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, created_at INTEGER NOT NULL,
    decided_at INTEGER, result TEXT, tool_call_id TEXT
  );

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, title TEXT NOT NULL, brief TEXT NOT NULL,
    status TEXT NOT NULL, progress TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    artifact_ids TEXT NOT NULL DEFAULT '[]', steps INTEGER NOT NULL DEFAULT 0,
    transcript TEXT NOT NULL DEFAULT '[]', pending_question TEXT
  );

  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL,
    task_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE activity (
    id TEXT PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL,
    detail TEXT, channel_id TEXT, task_id TEXT
  );
  CREATE INDEX activity_at ON activity(at);

  CREATE TABLE routines (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, cron TEXT NOT NULL, prompt TEXT NOT NULL,
    channel_id TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, last_run_at INTEGER
  );

  CREATE TABLE usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, day TEXT NOT NULL, model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, usd REAL NOT NULL,
    background INTEGER NOT NULL DEFAULT 0, task_id TEXT
  );
  CREATE INDEX usage_day ON usage(day);

  CREATE TABLE secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL, created_at INTEGER NOT NULL);

  CREATE TABLE push_subscriptions (endpoint TEXT PRIMARY KEY, json TEXT NOT NULL, created_at INTEGER NOT NULL);

  CREATE TABLE sessions (token TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);

  -- watermarks so check-ins only look at what's new
  CREATE TABLE seen (source TEXT NOT NULL, item TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(source, item));
  `,
];

export type DB = DatabaseSync;

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)");
  const row = db.prepare("SELECT v FROM schema_version").get() as { v: number } | undefined;
  let v = row?.v ?? 0;
  if (!row) db.prepare("INSERT INTO schema_version (v) VALUES (0)").run();
  for (; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.prepare("UPDATE schema_version SET v = ?").run(v + 1);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return db;
}

export function kvGet<T>(db: DB, key: string, fallback: T): T {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function kvSet(db: DB, key: string, value: unknown): void {
  db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    JSON.stringify(value),
  );
}

/** Turn free text into a safe FTS5 query: quoted prefix terms OR'd together. */
export function ftsQuery(q: string): string | null {
  const terms = q
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 1)
    .slice(0, 12);
  if (!terms.length) return null;
  return terms.map((t) => `"${t}"*`).join(" OR ");
}
