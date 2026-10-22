import type { RiskLevel } from "../../shared.ts";
import type { Tool, ToolOutput } from "../types.ts";
import { bool, num, obj, str } from "../types.ts";
import { bus } from "../../bus.ts";
import { assertPublicUrl } from "./web.ts";
import { truncate } from "../../util.ts";

// Minimal structural types so playwright-core stays an optional dependency.
type Page = any;
type Browser = any;

interface Elem {
  ref: number;
  role: string;
  label: string;
}

/**
 * The agent's own browser. Unlike Duet's, you can watch it live (frames stream to the
 * Activity tab) and take over with clicks and typing.
 */
export class BrowserSession {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private elems = new Map<number, Elem>();
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private opts: () => { headless: boolean; executablePath: string | null }) {}

  /** Serialize all browser operations. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => {});
    return run;
  }

  private async ensure(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    let pw: any;
    try {
      pw = await import("playwright-core");
    } catch {
      throw new Error("Browser unavailable: install playwright-core (npm i playwright-core) and Chrome/Chromium.");
    }
    const { headless, executablePath } = this.opts();
    const attempts: Record<string, unknown>[] = executablePath
      ? [{ executablePath }]
      : [{ channel: "chrome" }, { channel: "msedge" }, {}];
    let lastErr: unknown;
    for (const a of attempts) {
      try {
        this.browser = await pw.chromium.launch({ headless, ...a });
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!this.browser) throw new Error(`Could not launch a browser: ${(lastErr as Error)?.message}. Install Chrome or set the browser path in Settings → Safety.`);
    const ctx = await this.browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "en-US" });
    this.page = await ctx.newPage();
    return this.page;
  }

  async close() {
    await this.browser?.close().catch(() => {});
    this.browser = null;
    this.page = null;
  }

  private async frame() {
    if (!this.page) return;
    try {
      const buf: Buffer = await this.page.screenshot({ type: "jpeg", quality: 60 });
      bus.emitEvent({
        type: "browser_frame",
        image: `data:image/jpeg;base64,${buf.toString("base64")}`,
        url: this.page.url(),
        title: await this.page.title(),
        at: Date.now(),
      });
    } catch {}
  }

  /** Tag interactive elements with refs and return a text snapshot of the page. */
  private async snapshot(): Promise<string> {
    const page = await this.ensure();
    const data: { elems: Elem[]; text: string } = await page.evaluate(() => {
      const sel = 'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [contenteditable="true"], summary';
      const out: { ref: number; role: string; label: string }[] = [];
      let n = 0;
      document.querySelectorAll("[data-tandem-ref]").forEach((e) => e.removeAttribute("data-tandem-ref"));
      for (const el of Array.from(document.querySelectorAll(sel)) as HTMLElement[]) {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (r.width < 2 || r.height < 2 || style.visibility === "hidden" || style.display === "none") continue;
        n++;
        el.setAttribute("data-tandem-ref", String(n));
        const input = el as HTMLInputElement;
        const label =
          el.getAttribute("aria-label") ||
          (input.labels && input.labels[0]?.innerText) ||
          input.placeholder ||
          el.innerText ||
          input.value ||
          el.getAttribute("title") ||
          el.getAttribute("name") ||
          "";
        const role = el.getAttribute("role") || (el.tagName === "INPUT" ? `input[${input.type}]` : el.tagName.toLowerCase());
        out.push({ ref: n, role, label: label.replace(/\s+/g, " ").trim().slice(0, 80) });
        if (n >= 250) break;
      }
      return { elems: out, text: document.body.innerText };
    });
    this.elems = new Map(data.elems.map((e) => [e.ref, e]));
    const list = data.elems.map((e) => `[${e.ref}] ${e.role} “${e.label}”`).join("\n");
    return `URL: ${page.url()}\nTitle: ${await page.title()}\n\n## Page text\n${truncate(data.text, 12000)}\n\n## Interactive elements (use ref)\n${list}`;
  }

  labelOf(ref: unknown): string {
    return this.elems.get(Number(ref))?.label ?? "";
  }

  open(url: string) {
    return this.exclusive(async () => {
      const u = await assertPublicUrl(url);
      const page = await this.ensure();
      await page.goto(u.toString(), { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      await this.frame();
      return this.snapshot();
    });
  }

  read() {
    return this.exclusive(async () => {
      await this.frame();
      return this.snapshot();
    });
  }

  click(ref: number) {
    return this.exclusive(async () => {
      const page = await this.ensure();
      await page.click(`[data-tandem-ref="${ref}"]`, { timeout: 10000 });
      await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(600);
      await this.frame();
      return this.snapshot();
    });
  }

  type(ref: number, text: string, submit: boolean) {
    return this.exclusive(async () => {
      const page = await this.ensure();
      await page.fill(`[data-tandem-ref="${ref}"]`, text, { timeout: 10000 });
      if (submit) {
        await page.press(`[data-tandem-ref="${ref}"]`, "Enter");
        await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(600);
      }
      await this.frame();
      return this.snapshot();
    });
  }

  select(ref: number, value: string) {
    return this.exclusive(async () => {
      const page = await this.ensure();
      await page.selectOption(`[data-tandem-ref="${ref}"]`, { label: value }).catch(() => page.selectOption(`[data-tandem-ref="${ref}"]`, value));
      await this.frame();
      return this.snapshot();
    });
  }

  /** Fill a credential into a field. The value comes from the vault and is never returned. */
  fillSecret(ref: number, value: string) {
    return this.exclusive(async () => {
      const page = await this.ensure();
      await page.fill(`[data-tandem-ref="${ref}"]`, value, { timeout: 10000 });
      await this.frame();
      return `Filled. Current page: ${page.url()}`;
    });
  }

  scroll(down: boolean) {
    return this.exclusive(async () => {
      const page = await this.ensure();
      await page.mouse.wheel(0, down ? 700 : -700);
      await page.waitForTimeout(300);
      await this.frame();
      return this.snapshot();
    });
  }

  back() {
    return this.exclusive(async () => {
      const page = await this.ensure();
      await page.goBack({ timeout: 15000 }).catch(() => {});
      await this.frame();
      return this.snapshot();
    });
  }

  screenshot(): Promise<ToolOutput> {
    return this.exclusive(async () => {
      const page = await this.ensure();
      const buf: Buffer = await page.screenshot({ type: "jpeg", quality: 70 });
      await this.frame();
      return { text: `Screenshot of ${page.url()}`, images: [{ mediaType: "image/jpeg", data: buf.toString("base64") }], untrusted: true };
    });
  }

  currentHost(): string | null {
    try {
      return this.page ? new URL(this.page.url()).hostname : null;
    } catch {
      return null;
    }
  }

  /** User takeover from the UI. Coordinates are in page pixels. */
  takeover(a: { action: string; x?: number; y?: number; text?: string; url?: string }) {
    return this.exclusive(async () => {
      const page = await this.ensure();
      if (a.action === "click" && a.x !== undefined && a.y !== undefined) await page.mouse.click(a.x, a.y);
      else if (a.action === "type" && a.text) await page.keyboard.type(a.text, { delay: 20 });
      else if (a.action === "key" && a.text) await page.keyboard.press(a.text);
      else if (a.action === "navigate" && a.url) await page.goto((await assertPublicUrl(a.url)).toString(), { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(500);
      await this.frame();
    });
  }
}

const PAY = /\b(pay|buy|purchase|place order|checkout|check out|complete order|confirm (payment|purchase|order)|subscribe|donate)\b/i;
const SIGN = /\b(sign|i agree|accept( and continue)?|adopt and sign|finish signing)\b/i;
const DEL = /\b(delete|remove|cancel (account|subscription|order)|close account|unsubscribe)\b/i;
const SEND = /\b(send|post|publish|submit|reply|tweet|share|confirm|book|reserve|apply|register|sign up|save changes)\b/i;

export function clickRisk(label: string): RiskLevel {
  if (PAY.test(label)) return "payment";
  if (SIGN.test(label)) return "sign";
  if (DEL.test(label)) return "delete";
  if (SEND.test(label)) return "external";
  return "read";
}

export function browserTools(session: BrowserSession): Tool[] {
  const t = (tool: Omit<Tool, "source">): Tool => ({ ...tool, source: "builtin" });
  return [
    t({
      name: "browser_open",
      description:
        "Open a URL in your own cloud browser (for sites without a connector). Returns page text and numbered interactive elements. The user can watch live on the Activity tab.",
      parameters: obj({ url: str("URL") }),
      risk: "read",
      summarize: (a) => `Opened ${String(a.url).replace(/^https?:\/\//, "").slice(0, 50)}`,
      run: async (a) => ({ text: await session.open(String(a.url)), untrusted: true }),
    }),
    t({
      name: "browser_read",
      description: "Re-read the current page (text + element refs).",
      parameters: obj({}, []),
      risk: "read",
      summarize: () => "Read the current page",
      run: async () => ({ text: await session.read(), untrusted: true }),
    }),
    t({
      name: "browser_click",
      description: "Click an element by ref. Clicks that pay, sign, delete, send or submit need the user's approval.",
      parameters: obj({ ref: num("Element ref from the last snapshot") }),
      risk: (a) => clickRisk(session.labelOf(a.ref)),
      summarize: (a) => `Clicked “${session.labelOf(a.ref) || a.ref}”`,
      describe: (a) => ({
        title: `Click “${session.labelOf(a.ref) || `element ${a.ref}`}” on ${session.currentHost() ?? "the page"}`,
        preview: `The browser will click “${session.labelOf(a.ref)}” on ${session.currentHost()}. Watch it live on the Activity tab.`,
      }),
      run: async (a) => ({ text: await session.click(Number(a.ref)), untrusted: true }),
    }),
    t({
      name: "browser_type",
      description: "Type text into a field by ref (replaces its content). Set submit to press Enter.",
      parameters: obj({ ref: num("Element ref"), text: str("Text to enter"), submit: bool("Press Enter afterwards") }, ["ref", "text"]),
      risk: (a) => (a.submit ? "external" : "internal"),
      summarize: (a) => `Typed into “${session.labelOf(a.ref) || a.ref}”`,
      describe: (a) => ({
        title: `Type and submit on ${session.currentHost() ?? "the page"}`,
        preview: `Field: ${session.labelOf(a.ref)}\nText: ${a.text}\n(then press Enter)`,
      }),
      run: async (a) => ({ text: await session.type(Number(a.ref), String(a.text), !!a.submit), untrusted: true }),
    }),
    t({
      name: "browser_select",
      description: "Choose an option in a <select> by visible label.",
      parameters: obj({ ref: num("Element ref"), option: str("Option label") }),
      risk: "internal",
      summarize: (a) => `Selected “${a.option}”`,
      run: async (a) => ({ text: await session.select(Number(a.ref), String(a.option)), untrusted: true }),
    }),
    t({
      name: "browser_fill_secret",
      description:
        "Fill a stored credential (password, username, account number) into a field by ref without ever seeing it. Name the secret, e.g. ACME_PASSWORD. If it doesn't exist, ask the user to add it in Settings → Secrets — never ask them to paste passwords into chat.",
      parameters: obj({ ref: num("Field ref"), secret: str("Secret name") }),
      risk: "external",
      summarize: (a) => `Filled ${a.secret} into a login form`,
      describe: (a) => ({
        title: `Use ${a.secret} on ${session.currentHost() ?? "this site"}`,
        preview: `Tandem will type the stored secret ${a.secret} into “${session.labelOf(a.ref)}” on ${session.currentHost()}.\nOnly approve if that is the right site for this credential.`,
      }),
      run: async (a, { app }) => {
        const v = app.vault.get(String(a.secret));
        if (!v) return `No secret named ${a.secret}. Ask the user to add it in Settings → Secrets.`;
        return session.fillSecret(Number(a.ref), v);
      },
    }),
    t({
      name: "browser_scroll",
      description: "Scroll the page.",
      parameters: obj({ direction: str("up or down", { enum: ["up", "down"] }) }),
      risk: "read",
      summarize: () => "Scrolled",
      run: async (a) => ({ text: await session.scroll(a.direction !== "up"), untrusted: true }),
    }),
    t({
      name: "browser_back",
      description: "Go back.",
      parameters: obj({}, []),
      risk: "read",
      summarize: () => "Went back",
      run: async () => ({ text: await session.back(), untrusted: true }),
    }),
    t({
      name: "browser_screenshot",
      description: "Take a screenshot to see the page visually.",
      parameters: obj({}, []),
      risk: "read",
      summarize: () => "Took a screenshot",
      run: async () => session.screenshot(),
    }),
  ];
}
