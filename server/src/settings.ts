import type { Settings } from "./shared.ts";
import { DEFAULT_APPROVAL_RISKS } from "./shared.ts";
import type { DB } from "./db.ts";
import { kvGet, kvSet } from "./db.ts";
import { deepMerge } from "./util.ts";

export const DEFAULT_SETTINGS: Settings = {
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  userName: "",
  about: "",
  models: {
    work: "anthropic:claude-opus-5-5",
    triage: "anthropic:claude-haiku-5-5",
    fallbacks: [],
  },
  brief: { enabled: true, time: "07:30", weekdaysOnly: false },
  checkins: { enabled: true, everyHours: 3, activeFrom: "08:00", activeTo: "20:00" },
  quietHours: { enabled: true, from: "21:00", to: "07:00" },
  budget: { dailyBackgroundUsd: 2, perTaskUsd: 5 },
  safety: {
    approvalRequired: [...DEFAULT_APPROVAL_RISKS],
    blockSensitiveData: true,
    actionReviewer: false,
    maxPaymentUsd: 500,
  },
  notify: { webPush: true, ntfy: null, telegram: null, webhook: null },
  browser: { enabled: true, headless: true, executablePath: null },
  // Active only once a SUPERCOMPRESS_API_KEY is stored (or set in the environment).
  compression: { enabled: true, minChars: 6000, scope: "background" },
  sandbox: { enabled: false, image: "node:22-bookworm-slim" },
};

export class SettingsStore {
  private cache: Settings | null = null;
  private listeners: ((s: Settings) => void)[] = [];

  constructor(private db: DB) {}

  get(): Settings {
    if (!this.cache) this.cache = deepMerge(DEFAULT_SETTINGS, kvGet(this.db, "settings", {}));
    return this.cache;
  }

  update(patch: Partial<Settings>): Settings {
    const next = deepMerge(this.get(), patch);
    validate(next);
    // "forbidden" always stays blocked; it is never an approvable level.
    next.safety.approvalRequired = next.safety.approvalRequired.filter((r) => r !== "forbidden");
    kvSet(this.db, "settings", next);
    this.cache = next;
    for (const l of this.listeners) l(next);
    return next;
  }

  onChange(fn: (s: Settings) => void) {
    this.listeners.push(fn);
  }
}

function validate(s: Settings) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: s.timezone });
  } catch {
    throw new Error(`Unknown timezone "${s.timezone}"`);
  }
  for (const t of [s.brief.time, s.checkins.activeFrom, s.checkins.activeTo, s.quietHours.from, s.quietHours.to]) {
    if (!/^\d{2}:\d{2}$/.test(t)) throw new Error(`Times must be HH:MM, got "${t}"`);
  }
  if (!(s.checkins.everyHours >= 0.25 && s.checkins.everyHours <= 24)) throw new Error("Check-in interval must be 0.25–24 hours");
  if (s.compression.scope !== "background" && s.compression.scope !== "all") throw new Error('Compression scope must be "background" or "all"');
  if (!(s.compression.minChars >= 1000 && s.compression.minChars <= 200_000)) throw new Error("Compression threshold must be 1,000–200,000 characters");
  for (const m of [s.models.work, s.models.triage, ...s.models.fallbacks]) {
    if (!/^[a-z0-9_-]+:.+$/.test(m)) throw new Error(`Model "${m}" must look like provider:model`);
  }
}
