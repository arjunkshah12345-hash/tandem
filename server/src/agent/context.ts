import type { App } from "../app.ts";
import type { Message } from "../shared.ts";
import type { LlmMessage } from "../providers/types.ts";
import { formatLocal, truncate } from "../util.ts";

const HISTORY_LIMIT = 80;
const COMPACT_AT_CHARS = 120_000; // ≈30k tokens of chat history
const KEEP_RECENT = 24;

/**
 * Rebuild conversation context from the channel's stored messages. Prior turns are replayed
 * as plain text (tool activity summarized), never with provider reasoning blocks — so the
 * history can be freely compacted without invalidating anything.
 */
export function channelHistory(app: App, channelId: string): LlmMessage[] {
  const { upto } = app.store.getSummary(channelId);
  const rows = app.store.historyForContext(channelId, upto, HISTORY_LIMIT);
  return toLlm(app, rows.map((r) => r.msg));
}

export function toLlm(app: App, msgs: Message[]): LlmMessage[] {
  const tz = app.settings.get().timezone;
  const out: LlmMessage[] = [];
  const push = (role: "user" | "assistant", text: string) => {
    if (!text.trim()) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push({ type: "text", text });
    else out.push({ role, content: [{ type: "text", text }] });
  };
  for (const m of msgs) {
    const when = formatLocal(m.createdAt, tz);
    if (m.role === "user") {
      push("user", m.content);
    } else if (m.role === "system") {
      // approval outcomes and other notices — shown to the model as operator notes on the user side
      push("user", `<system_note at="${when}">${m.content}</system_note>`);
    } else {
      const label = m.kind === "brief" ? "[Morning brief] " : m.kind === "alert" ? "[Check-in alert] " : m.kind === "task_update" ? "[Task update] " : "";
      const acts = m.toolCalls.length
        ? `\n\n[actions: ${m.toolCalls.map((t) => `${t.summary}${t.status !== "ok" ? ` (${t.status.replace("_", " ")})` : ""}`).join("; ")}]`
        : "";
      const arts = m.artifactIds.length ? `\n[artifacts: ${m.artifactIds.join(", ")}]` : "";
      if (m.kind === "approval") continue; // approval cards are represented by their outcome notes
      push("assistant", `${label}${m.content}${acts}${arts}`);
    }
  }
  if (out.length && out[0].role === "assistant") out.unshift({ role: "user", content: [{ type: "text", text: "(earlier conversation)" }] });
  return out;
}

/** Summarize older history into the channel summary when it grows too long. Uses the cheap model. */
export async function maybeCompact(app: App, channelId: string): Promise<void> {
  const { summary, upto } = app.store.getSummary(channelId);
  const rows = app.store.historyForContext(channelId, upto, 400).map((r) => r.msg);
  const size = rows.reduce((n, m) => n + m.content.length + 200, 0);
  if (size < COMPACT_AT_CHARS || rows.length <= KEEP_RECENT) return;
  const old = rows.slice(0, rows.length - KEEP_RECENT);
  const transcript = old
    .map((m) => `${m.role === "user" ? "User" : m.role === "system" ? "System" : "Tandem"}: ${truncate(m.content, 2000)}`)
    .join("\n\n");
  const s = app.settings.get();
  try {
    const res = await app.providers.chat(
      [s.models.triage, s.models.work, ...s.models.fallbacks],
      {
        system: {
          stable:
            "You maintain a running summary of a conversation between a user and their assistant, Tandem. Keep: decisions, commitments, open questions, people and specifics (names, amounts, dates), what's been done and what's pending. Drop chit-chat. Write tight bullet points under short headings. Max ~600 words.",
        },
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: `${summary ? `Existing summary:\n${summary}\n\n` : ""}New conversation to fold in:\n\n${transcript}\n\nReturn the updated summary only.` }],
          },
        ],
        maxTokens: 4000,
        effort: "low",
      },
      { background: true },
    );
    const text = res.content.filter((b) => b.type === "text").map((b) => (b as any).text).join("").trim();
    if (text) app.store.setSummary(channelId, text, old[old.length - 1].createdAt);
  } catch (e) {
    app.store.log("error", "Couldn't compact history", String(e), channelId);
  }
}
