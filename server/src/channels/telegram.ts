import type { App } from "../app.ts";
import { bus } from "../bus.ts";
import type { Notification } from "../notify/notifier.ts";
import { sleep } from "../util.ts";

/**
 * Talk to Tandem from Telegram: messages go to the main thread, replies come back,
 * and approval requests arrive with Approve / Not now buttons.
 */
export class TelegramChannel {
  private running = false;
  private offset = 0;
  private abort: AbortController | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private app: App) {}

  private cfg() {
    const t = this.app.settings.get().notify.telegram;
    if (!t?.enabled) return null;
    const token = this.app.vault.get(t.botTokenSecret);
    return token ? { token, chatId: t.chatId } : null;
  }

  private async api(method: string, body: unknown, signal?: AbortSignal) {
    const c = this.cfg();
    if (!c) throw new Error("telegram not configured");
    const r = await fetch(`https://api.telegram.org/bot${c.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const j: any = await r.json();
    if (!j.ok) throw new Error(j.description ?? "telegram error");
    return j.result;
  }

  sink = async (n: Notification) => {
    const c = this.cfg();
    if (!c?.chatId) return;
    await this.api("sendMessage", {
      chat_id: c.chatId,
      text: `*${esc(n.title)}*\n${esc(n.body)}`.slice(0, 4000),
      parse_mode: "MarkdownV2",
      ...(n.approvalId
        ? {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "✅ Approve", callback_data: `ap:${n.approvalId}:approve` },
                  { text: "Not now", callback_data: `ap:${n.approvalId}:deny` },
                ],
              ],
            },
          }
        : {}),
    });
  };

  start() {
    if (this.running) return;
    this.running = true;
    this.app.notifier.sinks.push(this.sink);
    // Mirror assistant replies in the main thread back to Telegram while a Telegram conversation is active.
    this.unsubscribe = bus.onEvent((e) => {
      if (e.type !== "message" || e.message.channelId !== "main" || e.message.role !== "assistant") return;
      if (e.message.kind !== "chat" || e.message.taskId) return;
      const c = this.cfg();
      if (!c?.chatId || !this.lastInboundAt || Date.now() - this.lastInboundAt > 15 * 60_000) return;
      // final text arrives via message_update once streaming finishes
      this.pendingReplyId = e.message.id;
    });
    const off2 = bus.onEvent((e) => {
      if (e.type !== "message_update" || e.message.id !== this.pendingReplyId || !e.message.content.trim()) return;
      if (e.message.toolCalls.some((t) => t.status === "running")) return;
      this.pendingReplyId = null;
      const c = this.cfg();
      if (c?.chatId) this.api("sendMessage", { chat_id: c.chatId, text: e.message.content.slice(0, 4000) }).catch(() => {});
    });
    const off1 = this.unsubscribe;
    this.unsubscribe = () => {
      off1();
      off2();
    };
    void this.loop();
  }

  private lastInboundAt = 0;
  private pendingReplyId: string | null = null;

  stop() {
    this.running = false;
    this.abort?.abort();
    this.unsubscribe?.();
    this.app.notifier.sinks = this.app.notifier.sinks.filter((s) => s !== this.sink);
  }

  private async loop() {
    while (this.running) {
      const c = this.cfg();
      if (!c) {
        await sleep(30_000).catch(() => {});
        continue;
      }
      try {
        this.abort = new AbortController();
        const updates: any[] = await this.api("getUpdates", { offset: this.offset, timeout: 50, allowed_updates: ["message", "callback_query"] }, this.abort.signal);
        for (const u of updates) {
          this.offset = u.update_id + 1;
          await this.handle(u, c.chatId).catch((e) => this.app.store.log("error", "Telegram update failed", String(e)));
        }
      } catch (e) {
        if (!this.running) return;
        await sleep(10_000).catch(() => {});
      }
    }
  }

  private async handle(u: any, chatId: string | null) {
    if (u.callback_query) {
      const q = u.callback_query;
      if (String(q.message?.chat?.id) !== chatId) return;
      const [, apId, decision] = String(q.data).split(":");
      let text = "Done";
      try {
        const ap = await this.app.approvals.decide(apId, decision === "approve" ? "approve" : "deny");
        text = ap.status === "executed" ? "Approved and done ✅" : ap.status === "denied" ? "Okay, not now." : `Status: ${ap.status}`;
      } catch (e) {
        text = (e as Error).message;
      }
      await this.api("answerCallbackQuery", { callback_query_id: q.id, text });
      await this.api("editMessageReplyMarkup", { chat_id: chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      return;
    }
    const m = u.message;
    if (!m?.text) return;
    const from = String(m.chat.id);
    if (!chatId) {
      await this.api("sendMessage", { chat_id: from, text: `Hi! To link this chat, paste this chat ID into Tandem → Settings → Notifications → Telegram: ${from}` });
      return;
    }
    if (from !== chatId) return; // ignore strangers
    this.lastInboundAt = Date.now();
    await this.app.agent.userMessage("main", m.text, { via: "telegram" });
  }
}

function esc(s: string) {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}
