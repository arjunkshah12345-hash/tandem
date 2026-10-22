import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { randomBytes } from "node:crypto";
import type { ConnectorConfig } from "../shared.ts";
import type { Vault } from "../vault/vault.ts";
import type { Tool, ToolOutput } from "../tools/types.ts";
import { classifyTool } from "../policy/risk.ts";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean; title?: string };
}

/**
 * OAuth for remote MCP servers (Notion, Linear, Sentry, Atlassian, …). Tokens and the
 * dynamically-registered client live in the encrypted vault, never in the model context.
 */
class VaultOAuthProvider implements OAuthClientProvider {
  pendingAuthUrl: string | null = null;
  readonly stateValue = randomBytes(16).toString("hex");

  constructor(
    private connectorId: string,
    private vault: Vault,
    private callbackUrl: string,
  ) {}

  get redirectUrl() {
    return this.callbackUrl;
  }
  get clientMetadata() {
    return {
      client_name: "Tandem",
      redirect_uris: [this.callbackUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  state() {
    return `${this.connectorId}.${this.stateValue}`;
  }
  private read(kind: string): any {
    const v = this.vault.get(`mcp_oauth_${this.connectorId}_${kind}`);
    return v ? JSON.parse(v) : undefined;
  }
  private write(kind: string, v: unknown) {
    this.vault.set(`mcp_oauth_${this.connectorId}_${kind}`, JSON.stringify(v));
  }
  clientInformation() {
    return this.read("client");
  }
  saveClientInformation(info: unknown) {
    this.write("client", info);
  }
  tokens() {
    return this.read("tokens");
  }
  saveTokens(t: unknown) {
    this.write("tokens", t);
  }
  redirectToAuthorization(url: URL) {
    this.pendingAuthUrl = url.toString();
  }
  saveCodeVerifier(v: string) {
    this.write("verifier", v);
  }
  codeVerifier() {
    const v = this.read("verifier");
    if (!v) throw new Error("No PKCE verifier saved");
    return v as string;
  }
}

export class McpConnection {
  client: Client | null = null;
  tools: McpTool[] = [];
  state: "connected" | "connecting" | "error" | "needs_auth" | "disabled" = "connecting";
  error: string | null = null;
  oauth: VaultOAuthProvider | null = null;
  private transport: StreamableHTTPClientTransport | SSEClientTransport | StdioClientTransport | null = null;

  constructor(
    public cfg: ConnectorConfig,
    private vault: Vault,
    private callbackUrl: string,
  ) {}

  get authUrl() {
    return this.oauth?.pendingAuthUrl ?? null;
  }

  async connect(): Promise<void> {
    this.state = "connecting";
    this.error = null;
    try {
      const client = new Client({ name: "tandem", version: "0.1.0" });
      if (this.cfg.type === "mcp-stdio") {
        if (!this.cfg.command) throw new Error("No command configured");
        this.transport = new StdioClientTransport({
          command: this.cfg.command,
          args: this.cfg.args ?? [],
          env: { ...(process.env as Record<string, string>), ...this.vault.resolveRecord(this.cfg.env) },
          stderr: "pipe",
        });
        await client.connect(this.transport);
      } else {
        if (!this.cfg.url) throw new Error("No URL configured");
        const url = new URL(this.vault.resolve(this.cfg.url));
        const headers = this.vault.resolveRecord(this.cfg.headers);
        const hasAuthHeader = Object.keys(headers).some((h) => h.toLowerCase() === "authorization");
        this.oauth = hasAuthHeader ? null : (this.oauth ?? new VaultOAuthProvider(this.cfg.id, this.vault, this.callbackUrl));
        const opts = { requestInit: { headers }, authProvider: this.oauth ?? undefined };
        try {
          this.transport = new StreamableHTTPClientTransport(url, opts);
          await client.connect(this.transport);
        } catch (e) {
          if (e instanceof UnauthorizedError || this.oauth?.pendingAuthUrl) throw e;
          // Older servers only speak the legacy HTTP+SSE transport.
          this.transport = new SSEClientTransport(url, opts);
          await client.connect(this.transport);
        }
      }
      this.client = client;
      await this.refreshTools();
      this.state = "connected";
    } catch (e) {
      if (e instanceof UnauthorizedError || this.oauth?.pendingAuthUrl) {
        this.state = "needs_auth";
        this.error = "Sign-in required";
      } else {
        this.state = "error";
        this.error = e instanceof Error ? e.message : String(e);
      }
    }
  }

  /** Complete an OAuth redirect and reconnect. */
  async finishAuth(code: string): Promise<void> {
    const t = this.transport;
    if (!(t instanceof StreamableHTTPClientTransport || t instanceof SSEClientTransport)) throw new Error("Not an HTTP connector");
    await t.finishAuth(code);
    if (this.oauth) this.oauth.pendingAuthUrl = null;
    await this.connect();
  }

  async refreshTools() {
    if (!this.client) return;
    const out: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.listTools(cursor ? { cursor } : undefined);
      out.push(...(page.tools as McpTool[]));
      cursor = page.nextCursor;
    } while (cursor);
    this.tools = out;
  }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolOutput> {
    if (!this.client) throw new Error(`${this.cfg.name} is not connected (${this.error ?? this.state})`);
    const res: any = await this.client.callTool({ name, arguments: args }, undefined, { signal, timeout: 120_000 });
    const texts: string[] = [];
    const images: { mediaType: string; data: string }[] = [];
    for (const c of res.content ?? []) {
      if (c.type === "text") texts.push(c.text);
      else if (c.type === "image") images.push({ mediaType: c.mimeType, data: c.data });
      else if (c.type === "resource") texts.push(c.resource?.text ?? `[resource ${c.resource?.uri}]`);
      else if (c.type === "resource_link") texts.push(`[link ${c.uri}] ${c.name ?? ""}`);
    }
    if (res.structuredContent && !texts.length) texts.push(JSON.stringify(res.structuredContent, null, 2));
    const text = texts.join("\n") || "(no content)";
    if (res.isError) throw new Error(text);
    return { text, images: images.length ? images : undefined, untrusted: true };
  }

  async close() {
    try {
      await this.client?.close();
    } catch {}
    this.client = null;
  }

  /** Expose the server's tools to the agent, namespaced by connector id. */
  asTools(): Tool[] {
    const disabled = new Set(this.cfg.disabledTools ?? []);
    return this.tools
      .filter((t) => !disabled.has(t.name))
      .map((t): Tool => {
        const risk = this.cfg.riskOverrides?.[t.name] ?? classifyTool(t.name, t.description ?? "", t.annotations ?? {});
        const label = t.annotations?.title ?? t.name.replace(/[_-]/g, " ");
        return {
          name: toolName(this.cfg.id, t.name),
          description: `[${this.cfg.name}] ${t.description ?? label}`.slice(0, 1024),
          parameters: normalizeSchema(t.inputSchema),
          risk,
          source: this.cfg.id,
          summarize: (args) => `${this.cfg.name}: ${label}${briefArgs(args)}`,
          describe: (args) => ({ title: `${this.cfg.name} → ${label}`, preview: JSON.stringify(args, null, 2) }),
          run: (args, ctx) => this.call(t.name, args, ctx.signal),
        };
      });
  }
}

export function toolName(connectorId: string, name: string): string {
  return `${connectorId}__${name}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

function normalizeSchema(s: Record<string, unknown> | undefined): Record<string, unknown> {
  const schema = { ...(s ?? {}) } as Record<string, unknown>;
  if (schema.type !== "object") schema.type = "object";
  if (!schema.properties) schema.properties = {};
  delete schema.$schema;
  return schema;
}

function briefArgs(args: Record<string, unknown>): string {
  const first = Object.entries(args).find(([, v]) => typeof v === "string" && v.length > 0);
  if (!first) return "";
  const v = String(first[1]);
  return ` “${v.length > 50 ? v.slice(0, 50) + "…" : v}”`;
}
