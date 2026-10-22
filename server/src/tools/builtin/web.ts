import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Tool } from "../types.ts";
import { obj, str } from "../types.ts";
import { stripHtml } from "../../connectors/email.ts";
import { truncate } from "../../util.ts";
import type { Vault } from "../../vault/vault.ts";

/** Refuse to touch loopback / private networks unless explicitly allowed — blocks SSRF via prompt injection. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (!/^https?:$/.test(url.protocol)) throw new Error("Only http(s) URLs are allowed");
  if (process.env.TANDEM_ALLOW_PRIVATE_FETCH === "1") return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  for (const a of addrs) {
    if (isPrivate(a)) throw new Error(`Refusing to fetch private address ${a} (set TANDEM_ALLOW_PRIVATE_FETCH=1 to allow)`);
  }
  return url;
}

export function isPrivate(ip: string): boolean {
  if (ip.includes(":")) {
    const l = ip.toLowerCase();
    if (l.startsWith("::ffff:")) return isPrivate(l.slice(7));
    return l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80");
  }
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  );
}

const UA = "Mozilla/5.0 (compatible; Tandem/0.1; +https://github.com/tandem-agent/tandem)";

export async function fetchReadable(url: string, signal?: AbortSignal): Promise<{ title: string; text: string; status: number }> {
  const u = await assertPublicUrl(url);
  const res = await fetch(u, { headers: { "user-agent": UA, accept: "text/html,application/json,text/plain,*/*" }, signal, redirect: "follow" });
  const ct = res.headers.get("content-type") ?? "";
  const body = await res.text();
  if (/json|text\/plain|csv|xml/.test(ct) && !/html/.test(ct)) return { title: u.toString(), text: body, status: res.status };
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.trim() ?? u.toString();
  const main = /<(main|article)[\s\S]*?<\/\1>/i.exec(body)?.[0] ?? body;
  return { title, text: stripHtml(main.replace(/<(nav|footer|header|aside|form)[\s\S]*?<\/\1>/gi, "")), status: res.status };
}

interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

async function search(q: string, vault: Vault, signal?: AbortSignal): Promise<{ engine: string; hits: SearchHit[] }> {
  const tavily = vault.get("TAVILY_API_KEY");
  if (tavily) {
    const r = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tavily}` },
      body: JSON.stringify({ query: q, max_results: 8 }),
      signal,
    });
    const j: any = await r.json();
    return { engine: "tavily", hits: (j.results ?? []).map((x: any) => ({ title: x.title, url: x.url, snippet: x.content })) };
  }
  const brave = vault.get("BRAVE_API_KEY");
  if (brave) {
    const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=8`, {
      headers: { "X-Subscription-Token": brave, accept: "application/json" },
      signal,
    });
    const j: any = await r.json();
    return { engine: "brave", hits: (j.web?.results ?? []).map((x: any) => ({ title: x.title, url: x.url, snippet: stripHtml(x.description ?? "") })) };
  }
  const exa = vault.get("EXA_API_KEY");
  if (exa) {
    const r = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": exa },
      body: JSON.stringify({ query: q, numResults: 8, contents: { text: { maxCharacters: 400 } } }),
      signal,
    });
    const j: any = await r.json();
    return { engine: "exa", hits: (j.results ?? []).map((x: any) => ({ title: x.title, url: x.url, snippet: x.text ?? "" })) };
  }
  const searx = vault.get("SEARXNG_URL");
  if (searx) {
    const r = await fetch(`${searx.replace(/\/$/, "")}/search?format=json&q=${encodeURIComponent(q)}`, { signal });
    const j: any = await r.json();
    return { engine: "searxng", hits: (j.results ?? []).slice(0, 8).map((x: any) => ({ title: x.title, url: x.url, snippet: x.content ?? "" })) };
  }
  // Keyless fallback: DuckDuckGo's HTML endpoint.
  const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, { headers: { "user-agent": UA }, signal });
  const html = await r.text();
  const hits: SearchHit[] = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  for (const m of html.matchAll(re)) {
    let url = m[1];
    const uddg = /[?&]uddg=([^&]+)/.exec(url)?.[1];
    if (uddg) url = decodeURIComponent(uddg);
    hits.push({ title: stripHtml(m[2]), url, snippet: stripHtml(m[3]) });
    if (hits.length >= 8) break;
  }
  return { engine: "duckduckgo", hits };
}

const SECRET_RE = /\{\{secret:[A-Za-z0-9_.-]+\}\}/;

export const webTools: Tool[] = [
  {
    name: "web_search",
    description: "Search the web. Returns titles, URLs and snippets; use web_fetch to read a page.",
    parameters: obj({ query: str("Search query") }),
    risk: "read",
    source: "builtin",
    summarize: (a) => `Searched the web for “${a.query}”`,
    run: async (a, { app, signal }) => {
      const { engine, hits } = await search(String(a.query), app.vault, signal);
      if (!hits.length) return `No results (${engine}).`;
      return { text: hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join("\n"), untrusted: true };
    },
  },
  {
    name: "web_fetch",
    description: "Fetch a URL and return its readable text.",
    parameters: obj({ url: str("http(s) URL") }),
    risk: "read",
    source: "builtin",
    summarize: (a) => `Read ${hostOf(String(a.url))}`,
    run: async (a, { signal }) => {
      const r = await fetchReadable(String(a.url), signal);
      return { text: `# ${r.title} (HTTP ${r.status})\n\n${truncate(r.text, 40000)}`, untrusted: true };
    },
  },
  {
    name: "http_request",
    description:
      "Call a JSON/REST API directly. Reference stored credentials as {{secret:NAME}} inside headers or the URL — you never see the value. GET without secrets runs immediately; anything else needs the user's approval.",
    parameters: obj(
      {
        method: str("HTTP method", { enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] }),
        url: str("Full URL"),
        headers: { type: "object", description: "Request headers", additionalProperties: { type: "string" } },
        body: str("Request body (usually JSON text)"),
      },
      ["method", "url"],
    ),
    risk: (a) => {
      const m = String(a.method ?? "GET").toUpperCase();
      if (m === "DELETE") return "delete";
      if ((m === "GET" || m === "HEAD") && !SECRET_RE.test(JSON.stringify(a))) return "read";
      return "external";
    },
    source: "builtin",
    summarize: (a) => `${a.method} ${hostOf(String(a.url))}`,
    describe: (a) => ({
      title: `${a.method} request to ${hostOf(String(a.url))}`,
      preview: `${a.method} ${a.url}\n${Object.entries((a.headers as Record<string, string>) ?? {})
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n")}${a.body ? `\n\n${a.body}` : ""}`,
    }),
    run: async (a, { app, signal }) => {
      const url = await assertPublicUrl(app.vault.resolve(String(a.url)));
      const headers = app.vault.resolveRecord((a.headers as Record<string, string>) ?? {});
      const res = await fetch(url, { method: String(a.method), headers, body: a.body ? String(a.body) : undefined, signal });
      const text = await res.text();
      return { text: `HTTP ${res.status}\n${truncate(text, 30000)}`, untrusted: true };
    },
  },
];

function hostOf(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return u.slice(0, 40);
  }
}
