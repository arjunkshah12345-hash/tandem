import webpush from "web-push";
import type { DB } from "../db.ts";
import { kvGet, kvSet } from "../db.ts";
import type { SettingsStore } from "../settings.ts";
import type { Vault } from "../vault/vault.ts";
import type { Store } from "../store.ts";
import { inWindow, zonedParts } from "../util.ts";

export interface Notification {
  title: string;
  body: string;
  /** Deep link inside the app, e.g. "/?channel=main". */
  url?: string;
  /** Bypass quiet hours (approvals that block work, explicit user-requested reminders). */
  urgent?: boolean;
  approvalId?: string;
}

/** Fan-out to every configured channel. Push is how a proactive agent "messages you first". */
export class Notifier {
  /** Extra sinks (e.g. Telegram bot with inline approval buttons). */
  sinks: ((n: Notification) => Promise<void>)[] = [];

  constructor(
    private db: DB,
    private settings: SettingsStore,
    private vault: Vault,
    private store: Store,
    private publicUrl: () => string,
  ) {
    const keys = this.vapid();
    webpush.setVapidDetails("mailto:tandem@localhost", keys.publicKey, keys.privateKey);
  }

  vapid(): { publicKey: string; privateKey: string } {
    let keys = kvGet<{ publicKey: string; privateKey: string } | null>(this.db, "vapid", null);
    if (!keys) {
      keys = webpush.generateVAPIDKeys();
      kvSet(this.db, "vapid", keys);
    }
    return keys;
  }

  subscribe(sub: { endpoint: string }) {
    this.db
      .prepare("INSERT INTO push_subscriptions (endpoint, json, created_at) VALUES (?,?,?) ON CONFLICT(endpoint) DO UPDATE SET json = excluded.json")
      .run(sub.endpoint, JSON.stringify(sub), Date.now());
  }

  inQuietHours(): boolean {
    const s = this.settings.get();
    if (!s.quietHours.enabled) return false;
    return inWindow(zonedParts(Date.now(), s.timezone).minutes, s.quietHours.from, s.quietHours.to);
  }

  async send(n: Notification): Promise<void> {
    if (this.inQuietHours() && !n.urgent) {
      this.store.log("notify", `Held during quiet hours: ${n.title}`, n.body);
      const held = kvGet<Notification[]>(this.db, "held_notifications", []);
      held.push(n);
      kvSet(this.db, "held_notifications", held.slice(-20));
      return;
    }
    const s = this.settings.get().notify;
    const jobs: Promise<unknown>[] = [];
    const link = this.publicUrl() + (n.url ?? "/");

    if (s.webPush) {
      const subs = this.db.prepare("SELECT endpoint, json FROM push_subscriptions").all() as { endpoint: string; json: string }[];
      for (const sub of subs) {
        jobs.push(
          webpush.sendNotification(JSON.parse(sub.json), JSON.stringify({ title: n.title, body: n.body, url: n.url ?? "/" })).catch((e: any) => {
            if (e?.statusCode === 404 || e?.statusCode === 410) this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(sub.endpoint);
          }),
        );
      }
    }
    if (s.ntfy?.enabled && s.ntfy.topic) {
      jobs.push(
        fetch(`${s.ntfy.server.replace(/\/$/, "")}/${encodeURIComponent(s.ntfy.topic)}`, {
          method: "POST",
          headers: { Title: encodeHeader(n.title), Click: link, Tags: n.approvalId ? "raised_hand" : "sparkles" },
          body: n.body,
        }),
      );
    }
    if (s.webhook?.enabled && s.webhook.url) {
      jobs.push(
        fetch(s.webhook.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: n.title, body: n.body, url: link, approvalId: n.approvalId ?? null, text: `*${n.title}*\n${n.body}\n${link}` }),
        }),
      );
    }
    for (const sink of this.sinks) jobs.push(sink(n));
    const results = await Promise.allSettled(jobs);
    const failed = results.filter((r) => r.status === "rejected").length;
    this.store.log("notify", `Notified: ${n.title}`, failed ? `${failed} channel(s) failed` : null);
  }

  /** Deliver anything held overnight (called when quiet hours end). */
  async flushHeld() {
    const held = kvGet<Notification[]>(this.db, "held_notifications", []);
    if (!held.length || this.inQuietHours()) return;
    kvSet(this.db, "held_notifications", []);
    if (held.length === 1) await this.send(held[0]);
    else await this.send({ title: `${held.length} updates while you were away`, body: held.map((h) => `• ${h.title}`).join("\n"), url: "/" });
  }
}

function encodeHeader(s: string) {
  // ntfy accepts RFC 2047 for non-ASCII titles
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString("base64")}?=`;
}
