import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { openDb, kvGet, kvSet, type DB } from "./db.ts";
import { Store } from "./store.ts";
import { Vault } from "./vault/vault.ts";
import { SettingsStore } from "./settings.ts";
import { Providers } from "./providers/registry.ts";
import { ConnectorManager } from "./connectors/manager.ts";
import { Skills } from "./skills/skills.ts";
import { Compressor, fullResultTool, SUPERCOMPRESS_KEY_SECRET } from "./compress/supercompress.ts";
import { Notifier } from "./notify/notifier.ts";
import { Agent } from "./agent/agent.ts";
import { TaskRunner } from "./agent/tasks.ts";
import { Approvals } from "./agent/approvals.ts";
import { ActionReviewer } from "./agent/reviewer.ts";
import { Scheduler, Budget } from "./scheduler/scheduler.ts";
import { TelegramChannel } from "./channels/telegram.ts";
import type { Tool } from "./tools/types.ts";
import { coreTools } from "./tools/builtin/core.ts";
import { webTools } from "./tools/builtin/web.ts";
import { BrowserSession, browserTools } from "./tools/builtin/browser.ts";

export interface AppConfig {
  dataDir: string;
  port: number;
  host: string;
  publicUrl: string;
}

export function loadConfig(env = process.env): AppConfig {
  const port = Number(env.TANDEM_PORT ?? env.PORT ?? 7420);
  return {
    dataDir: resolve(env.TANDEM_DATA_DIR ?? join(homedir(), ".tandem")),
    port,
    host: env.TANDEM_HOST ?? "127.0.0.1",
    publicUrl: (env.TANDEM_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ""),
  };
}

const here = dirname(fileURLToPath(import.meta.url));
/** Repo root (works from src/ under tsx and from dist/ after build). */
export const ROOT = resolve(here, "..", "..");

export class App {
  db: DB;
  store: Store;
  vault: Vault;
  settings: SettingsStore;
  providers: Providers;
  connectors: ConnectorManager;
  skills: Skills;
  notifier: Notifier;
  agent: Agent;
  tasks: TaskRunner;
  approvals: Approvals;
  reviewer: ActionReviewer;
  scheduler: Scheduler;
  budget: Budget;
  browser: BrowserSession;
  telegram: TelegramChannel;
  compressor: Compressor;
  kv: { get<T>(k: string, fallback: T): T; set(k: string, v: unknown): void };

  constructor(public config: AppConfig) {
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    this.db = openDb(join(config.dataDir, "tandem.db"));
    this.kv = { get: (k, f) => kvGet(this.db, k, f), set: (k, v) => kvSet(this.db, k, v) };
    this.store = new Store(this.db);
    this.vault = new Vault(this.db, join(config.dataDir, "vault.key"));
    this.settings = new SettingsStore(this.db);
    this.providers = new Providers(this.db, this.vault, () => this.settings.get().timezone);
    this.connectors = new ConnectorManager(this.db, this.vault, () => `${config.publicUrl}/api/connectors/oauth/callback`);
    this.skills = new Skills([
      { path: join(config.dataDir, "skills"), builtin: false },
      { path: join(ROOT, "skills"), builtin: true },
    ]);
    this.notifier = new Notifier(this.db, this.settings, this.vault, this.store, () => config.publicUrl);
    this.agent = new Agent(this);
    this.tasks = new TaskRunner(this);
    this.approvals = new Approvals(this);
    this.reviewer = new ActionReviewer(this);
    this.scheduler = new Scheduler(this);
    this.budget = new Budget(this);
    this.browser = new BrowserSession(() => this.settings.get().browser);
    this.telegram = new TelegramChannel(this);
    this.compressor = new Compressor(this);

    this.settings.onChange(() => {
      this.scheduler.reloadRoutines();
      this.providers.invalidate();
    });
  }

  /** The agent's toolbox for a given context. */
  tools(o: { task: boolean }): Tool[] {
    const out: Tool[] = coreTools.filter((t) => o.task || t.source !== "builtin:task");
    out.push(...webTools);
    if (this.settings.get().browser.enabled) out.push(...browserTools(this.browser));
    out.push(...this.connectors.tools());
    // Offered whenever compression is configured (not tied to transient pauses, to keep the tool list stable).
    if (this.settings.get().compression.enabled && this.vault.has(SUPERCOMPRESS_KEY_SECRET)) out.push(fullResultTool);
    // Deterministic order keeps provider prompt caches warm.
    return out.sort((a, b) => (a.source === b.source ? a.name.localeCompare(b.name) : a.source.startsWith("builtin") ? -1 : b.source.startsWith("builtin") ? 1 : a.source.localeCompare(b.source)));
  }

  async start() {
    await this.connectors.start();
    this.tasks.recover();
    this.scheduler.start();
    this.telegram.start();
    this.store.log("system", "Tandem started");
  }

  async stop() {
    this.scheduler.stop();
    this.telegram.stop();
    this.agent.stopAll();
    await this.connectors.stop();
    await this.browser.close();
    this.db.close();
  }
}
