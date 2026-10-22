import type { ConnectorConfig, ConnectorStatus } from "../shared.ts";
import type { DB } from "../db.ts";
import { kvGet, kvSet } from "../db.ts";
import type { Vault } from "../vault/vault.ts";
import type { Tool } from "../tools/types.ts";
import { bus } from "../bus.ts";
import { McpConnection } from "./mcp.ts";
import { EmailConnection } from "./email.ts";
import { CalendarConnection } from "./calendar.ts";

type Conn = McpConnection | EmailConnection | CalendarConnection;

export class ConnectorManager {
  private conns = new Map<string, Conn>();

  constructor(
    private db: DB,
    private vault: Vault,
    private callbackUrl: () => string,
  ) {}

  configs(): ConnectorConfig[] {
    return Object.values(kvGet<Record<string, ConnectorConfig>>(this.db, "connectors", {}));
  }

  async start() {
    await Promise.all(this.configs().filter((c) => c.enabled).map((c) => this.open(c)));
  }

  async save(cfg: ConnectorConfig): Promise<ConnectorConfig> {
    if (!/^[a-z0-9_]{1,24}$/.test(cfg.id)) throw new Error("Connector id must be 1–24 chars of a-z, 0-9 or _");
    const all = kvGet<Record<string, ConnectorConfig>>(this.db, "connectors", {});
    all[cfg.id] = cfg;
    kvSet(this.db, "connectors", all);
    await this.close(cfg.id);
    if (cfg.enabled) await this.open(cfg);
    else this.emit(cfg.id);
    return cfg;
  }

  async remove(id: string) {
    const all = kvGet<Record<string, ConnectorConfig>>(this.db, "connectors", {});
    delete all[id];
    kvSet(this.db, "connectors", all);
    await this.close(id);
  }

  async reconnect(id: string) {
    const cfg = this.configs().find((c) => c.id === id);
    if (!cfg) throw new Error("connector not found");
    await this.close(id);
    await this.open(cfg);
  }

  private async open(cfg: ConnectorConfig) {
    let conn: Conn;
    if (cfg.type === "email") conn = new EmailConnection(cfg, this.vault);
    else if (cfg.type === "calendar-ics") conn = new CalendarConnection(cfg, this.vault);
    else conn = new McpConnection(cfg, this.vault, this.callbackUrl());
    this.conns.set(cfg.id, conn);
    this.emit(cfg.id);
    if (conn instanceof McpConnection) await conn.connect();
    else await conn.test();
    this.emit(cfg.id);
  }

  private async close(id: string) {
    const c = this.conns.get(id);
    if (c instanceof McpConnection) await c.close();
    this.conns.delete(id);
  }

  async stop() {
    for (const id of [...this.conns.keys()]) await this.close(id);
  }

  /** OAuth redirect lands here; state is "<connectorId>.<nonce>". */
  async finishOAuth(state: string, code: string) {
    const [id, nonce] = state.split(".");
    const c = this.conns.get(id);
    if (!(c instanceof McpConnection) || !c.oauth || c.oauth.stateValue !== nonce) throw new Error("Unknown or expired sign-in");
    await c.finishAuth(code);
    this.emit(id);
  }

  status(): ConnectorStatus[] {
    return this.configs().map((cfg) => this.statusOf(cfg));
  }

  private statusOf(cfg: ConnectorConfig): ConnectorStatus {
    const c = this.conns.get(cfg.id);
    if (!cfg.enabled || !c) return { id: cfg.id, state: "disabled", error: null, tools: [] };
    const tools = c.state === "connected" ? c.asTools() : [];
    return {
      id: cfg.id,
      state: c.state,
      error: c.error,
      authUrl: c instanceof McpConnection ? c.authUrl : null,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        risk: typeof t.risk === "function" ? "external" : t.risk,
      })),
    };
  }

  private emit(id: string) {
    const cfg = this.configs().find((c) => c.id === id);
    if (cfg) bus.emitEvent({ type: "connector", status: this.statusOf(cfg) });
  }

  tools(): Tool[] {
    const out: Tool[] = [];
    for (const c of this.conns.values()) if (c.state === "connected") out.push(...c.asTools());
    return out;
  }

  emailAccounts(): EmailConnection[] {
    return [...this.conns.values()].filter((c): c is EmailConnection => c instanceof EmailConnection && c.state === "connected");
  }

  calendars(): CalendarConnection[] {
    return [...this.conns.values()].filter((c): c is CalendarConnection => c instanceof CalendarConnection && c.state === "connected");
  }

  /** Short description of what's connected, for the system prompt. */
  describe(): string {
    const lines = this.configs()
      .filter((c) => c.enabled)
      .map((c) => {
        const s = this.conns.get(c.id);
        return `- ${c.name} (${c.id}): ${s?.state ?? "disabled"}${s?.error ? ` — ${s.error}` : ""}`;
      });
    return lines.length ? lines.join("\n") : "- (none yet — suggest the user connect email, calendar, and the apps they work in)";
  }
}
