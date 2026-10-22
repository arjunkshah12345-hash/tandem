import { Cron } from "croner";
import type { App } from "../app.ts";
import type { Routine } from "../shared.ts";
import { BRIEF_PROMPT, CHECKIN_PROMPT, ROUTINE_PROMPT } from "../agent/prompt.ts";
import { errorMessage, formatLocal, hm, inWindow, truncate, zonedParts } from "../util.ts";

const BRIEF_GRACE_MIN = 180; // if the server was down at brief time, still send it within 3h

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private jobs = new Map<string, Cron>();
  private running = new Set<string>();

  constructor(private app: App) {}

  start() {
    this.reloadRoutines();
    this.timer = setInterval(() => void this.tick(), 60_000);
    setTimeout(() => void this.tick(), 5_000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    for (const j of this.jobs.values()) j.stop();
    this.jobs.clear();
  }

  private async tick() {
    const s = this.app.settings.get();
    const nowMs = Date.now();
    const local = zonedParts(nowMs, s.timezone);
    try {
      // Morning brief
      if (s.brief.enabled && !(s.brief.weekdaysOnly && (local.weekday === "Sat" || local.weekday === "Sun"))) {
        const last = this.app.kv.get<string>("last_brief_date", "");
        const delta = local.minutes - hm(s.brief.time);
        if (last !== local.date && delta >= 0 && delta <= BRIEF_GRACE_MIN) {
          this.app.kv.set("last_brief_date", local.date);
          void this.runBrief();
        }
      }
      // Check-ins
      if (s.checkins.enabled && inWindow(local.minutes, s.checkins.activeFrom, s.checkins.activeTo) && !this.app.notifier.inQuietHours()) {
        const last = this.app.kv.get<number>("last_checkin_at", 0);
        if (nowMs - last >= s.checkins.everyHours * 3600_000) void this.runCheckin();
      }
      await this.app.notifier.flushHeld();
      // Daily housekeeping
      if (this.app.kv.get<string>("last_housekeeping", "") !== local.date) {
        this.app.kv.set("last_housekeeping", local.date);
        this.app.approvals.expireOld();
        this.app.kv.set("budget_notice_date", "");
      }
    } catch (e) {
      this.app.store.log("error", "Scheduler tick failed", errorMessage(e));
    }
  }

  private budgetGate(label: string): boolean {
    const reason = this.app.budget.backgroundBlocked();
    if (!reason) return true;
    this.app.store.log("system", `Skipped ${label}: ${reason}`);
    const today = zonedParts(Date.now(), this.app.settings.get().timezone).date;
    if (this.app.kv.get<string>("budget_notice_date", "") !== today) {
      this.app.kv.set("budget_notice_date", today);
      this.app.store.addMessage({
        channelId: "main",
        role: "system",
        kind: "system",
        content: `Background work is paused for today: ${reason}. Raise the daily budget in Settings → Schedule if you want me to keep checking.`,
      });
    }
    return false;
  }

  async runBrief(force = false) {
    if (this.running.has("brief")) return;
    if (!force && !this.budgetGate("morning brief")) return;
    this.running.add("brief");
    try {
      const s = this.app.settings.get();
      this.app.store.log("brief", "Preparing morning brief");
      const date = formatLocal(Date.now(), s.timezone).split(" at ")[0];
      const fresh = await this.prefetch();
      const prompt = BRIEF_PROMPT(date) + (fresh.text ? `\n\nPre-fetched new items:\n${fresh.text}` : "");
      const res = await this.app.agent.scheduled("main", "brief", prompt, "brief", "Writing your morning brief");
      fresh.markSeen();
      if (res?.text) {
        const firstLine = res.lastText.split("\n").find((l) => l.trim()) ?? "Your morning brief is ready.";
        await this.app.notifier.send({ title: "☀️ Morning brief", body: truncate(firstLine.replace(/[*_#`]/g, ""), 200), url: "/" });
      }
    } finally {
      this.running.delete("brief");
    }
  }

  async runCheckin(force = false) {
    if (this.running.has("checkin")) return;
    if (!force && !this.budgetGate("check-in")) return;
    this.running.add("checkin");
    const s = this.app.settings.get();
    const last = this.app.kv.get<number>("last_checkin_at", 0);
    this.app.kv.set("last_checkin_at", Date.now());
    try {
      const fresh = await this.prefetch();
      const since = last ? formatLocal(last, s.timezone) : "never (first check-in)";
      const res = await this.app.agent.turn("main", {
        mode: "checkin",
        hiddenPrompt: CHECKIN_PROMPT(since, fresh.text),
        background: true,
        silent: true,
        maxSteps: 12,
        typingLabel: "Checking in",
      });
      fresh.markSeen();
      if (!res) return;
      const out = res.lastText.trim();
      const m = /NOTIFY:\s*([\s\S]+)/.exec(out);
      if (m) {
        const body = m[1].trim();
        this.app.store.addMessage({
          channelId: "main",
          role: "assistant",
          kind: "alert",
          content: body,
          toolCalls: res.views,
          artifactIds: res.artifactIds,
          model: res.model,
        });
        const headline = body.split("\n").find((l) => l.trim()) ?? "Something needs you";
        await this.app.notifier.send({ title: "Tandem", body: truncate(headline.replace(/[*_#`]/g, ""), 200), url: "/" });
        this.app.store.log("checkin", `Check-in: flagged — ${truncate(headline, 100)}`);
      } else {
        const why = /QUIET:\s*(.*)/.exec(out)?.[1] ?? truncate(out, 200);
        this.app.store.log("checkin", "Check-in: nothing urgent", why || null);
      }
    } catch (e) {
      this.app.store.log("error", "Check-in failed", errorMessage(e));
    } finally {
      this.running.delete("checkin");
    }
  }

  /** Cheap deterministic pre-fetch of what's new in built-in connectors, so check-ins start informed. */
  private async prefetch(): Promise<{ text: string; markSeen: () => void }> {
    const lines: string[] = [];
    const seen: [string, string[]][] = [];
    for (const acct of this.app.connectors.emailAccounts()) {
      try {
        const msgs = await acct.search({ unseen: true, sinceDays: 2, limit: 25 });
        const src = `email:${acct.cfg.id}`;
        const ids = this.app.store.unseen(src, msgs.map((m) => m.messageId));
        const fresh = msgs.filter((m) => ids.includes(m.messageId));
        if (fresh.length) {
          lines.push(`New unread email in ${acct.cfg.name} (use ${acct.cfg.id}__read with uid):`);
          for (const m of fresh) lines.push(`- uid ${m.uid} · ${m.date.slice(0, 16)} · ${m.from} · “${m.subject}”`);
        }
        seen.push([src, ids]);
      } catch (e) {
        lines.push(`(${acct.cfg.name}: couldn't check — ${errorMessage(e)})`);
      }
    }
    for (const cal of this.app.connectors.calendars()) {
      try {
        const ev = await cal.between(Date.now(), Date.now() + 4 * 3600_000);
        if (ev.length) {
          lines.push(`Coming up in ${cal.cfg.name} (next 4h):`);
          for (const e of ev) lines.push(`- ${e.start} – ${e.title}${e.attendees.length ? ` (with ${e.attendees.slice(0, 5).join(", ")})` : ""}`);
        }
      } catch {}
    }
    return {
      text: lines.length ? `<untrusted_content source="prefetch">\n${lines.join("\n")}\n</untrusted_content>` : "",
      markSeen: () => {
        for (const [src, ids] of seen) this.app.store.markSeen(src, ids);
      },
    };
  }

  // ---------------- routines ----------------
  reloadRoutines() {
    for (const j of this.jobs.values()) j.stop();
    this.jobs.clear();
    const tz = this.app.settings.get().timezone;
    for (const r of this.app.store.listRoutines()) {
      if (!r.enabled) continue;
      try {
        this.jobs.set(r.id, new Cron(r.cron, { timezone: tz, protect: true }, () => void this.runRoutine(r.id)));
      } catch (e) {
        this.app.store.log("error", `Routine “${r.name}” has an invalid schedule`, errorMessage(e));
      }
    }
  }

  nextRun(id: string): number | null {
    return this.jobs.get(id)?.nextRun()?.getTime() ?? null;
  }

  routines(): Routine[] {
    return this.app.store.listRoutines().map((r) => ({ ...r, nextRunAt: this.nextRun(r.id) }));
  }

  async runRoutine(id: string, force = false) {
    const r = this.app.store.listRoutines().find((x) => x.id === id);
    if (!r || this.running.has(id)) return;
    if (!force && !this.budgetGate(`routine “${r.name}”`)) return;
    this.running.add(id);
    try {
      this.app.store.updateRoutine(id, { lastRunAt: Date.now() });
      this.app.store.log("routine", `Running routine: ${r.name}`, null, r.channelId);
      const channelId = this.app.store.getChannel(r.channelId) ? r.channelId : "main";
      const res = await this.app.agent.scheduled(channelId, "routine", ROUTINE_PROMPT(r.name, r.prompt), "chat", r.name);
      if (res?.lastText) await this.app.notifier.send({ title: r.name, body: truncate(res.lastText.replace(/[*_#`]/g, ""), 200), url: `/?channel=${channelId}` });
    } finally {
      this.running.delete(id);
    }
  }
}

export class Budget {
  constructor(private app: App) {}

  backgroundBlocked(): string | null {
    const cap = this.app.settings.get().budget.dailyBackgroundUsd;
    if (!cap) return null;
    const spent = this.app.providers.backgroundSpendToday();
    return spent >= cap ? `today's background budget of $${cap.toFixed(2)} is used up ($${spent.toFixed(2)})` : null;
  }
}
