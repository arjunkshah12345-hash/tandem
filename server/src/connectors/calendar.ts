import ical from "node-ical";
import type { ConnectorConfig } from "../shared.ts";
import type { Vault } from "../vault/vault.ts";
import type { Tool } from "../tools/types.ts";
import { num, obj } from "../tools/types.ts";

export interface CalEvent {
  uid: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string | null;
  attendees: string[];
  description: string | null;
}

/**
 * Read-only calendar from a secret ICS feed (Google Calendar "secret address in iCal format",
 * iCloud public calendar, Outlook published calendar, Fastmail, …).
 */
export class CalendarConnection {
  state: "connected" | "error" | "connecting" = "connecting";
  error: string | null = null;
  private cache: { at: number; events: CalEvent[] } | null = null;

  constructor(
    public cfg: ConnectorConfig,
    private vault: Vault,
  ) {}

  async test() {
    try {
      await this.load(true);
      this.state = "connected";
      this.error = null;
    } catch (e) {
      this.state = "error";
      this.error = (e as Error).message;
    }
  }

  private async load(force = false): Promise<CalEvent[]> {
    if (!force && this.cache && Date.now() - this.cache.at < 5 * 60_000) return this.cache.events;
    const url = this.cfg.icsUrlSecret ? this.vault.get(this.cfg.icsUrlSecret) : null;
    if (!url) throw new Error("Calendar feed URL secret is missing");
    const data = await ical.async.fromURL(url.replace(/^webcal:/, "https:"));
    const horizonStart = Date.now() - 2 * 86400_000;
    const horizonEnd = Date.now() + 60 * 86400_000;
    const events: CalEvent[] = [];
    for (const v of Object.values(data) as any[]) {
      if (v?.type !== "VEVENT") continue;
      const base = (s: Date, e: Date, key: string): CalEvent => ({
        uid: key,
        title: typeof v.summary === "string" ? v.summary : (v.summary?.val ?? "(untitled)"),
        start: s.toISOString(),
        end: e.toISOString(),
        allDay: v.datetype === "date",
        location: v.location ? String(v.location?.val ?? v.location) : null,
        attendees: ([] as any[]).concat(v.attendee ?? []).map((a) => String(a?.params?.CN ?? a?.val ?? a).replace(/^mailto:/i, "")),
        description: v.description ? String(v.description?.val ?? v.description).slice(0, 2000) : null,
      });
      const dur = (v.end?.getTime?.() ?? v.start.getTime()) - v.start.getTime();
      if (v.rrule) {
        for (const occ of v.rrule.between(new Date(horizonStart), new Date(horizonEnd), true) as Date[]) {
          const key = occ.toISOString().slice(0, 10);
          if (v.exdate && Object.keys(v.exdate).some((k) => k.startsWith(key))) continue;
          const override = v.recurrences?.[key];
          const s = override?.start ?? occ;
          const e = override?.end ?? new Date(s.getTime() + dur);
          events.push(base(s, e, `${v.uid}@${key}`));
        }
      } else if (v.start && v.start.getTime() < horizonEnd && (v.end ?? v.start).getTime() > horizonStart) {
        events.push(base(v.start, v.end ?? v.start, v.uid));
      }
    }
    events.sort((a, b) => a.start.localeCompare(b.start));
    this.cache = { at: Date.now(), events };
    return events;
  }

  async between(fromMs: number, toMs: number): Promise<CalEvent[]> {
    const ev = await this.load();
    return ev.filter((e) => Date.parse(e.end) >= fromMs && Date.parse(e.start) <= toMs);
  }

  asTools(): Tool[] {
    return [
      {
        name: `${this.cfg.id}__events`,
        description: `[${this.cfg.name}] List calendar events in a window relative to now.`,
        parameters: obj(
          { fromHours: num("Start offset from now in hours (negative for past). Default 0"), toHours: num("End offset in hours. Default 48") },
          [],
        ),
        risk: "read",
        source: this.cfg.id,
        summarize: () => `Checked ${this.cfg.name}`,
        run: async (a) => {
          const from = Date.now() + Number(a.fromHours ?? 0) * 3600_000;
          const to = Date.now() + Number(a.toHours ?? 48) * 3600_000;
          const ev = await this.between(from, to);
          return { text: ev.length ? JSON.stringify(ev, null, 1) : "No events in that window.", untrusted: true };
        },
      },
    ];
  }
}
