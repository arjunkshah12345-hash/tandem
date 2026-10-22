import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import type { ConnectorConfig } from "../shared.ts";
import type { Vault } from "../vault/vault.ts";
import type { Tool } from "../tools/types.ts";
import { num, obj, str, bool } from "../tools/types.ts";
import { truncate } from "../util.ts";

/**
 * Plain IMAP/SMTP email — works with Gmail/Google Workspace (app password), Fastmail,
 * iCloud, Outlook.com, Proton Bridge, any self-hosted server. No OAuth app needed.
 */
export class EmailConnection {
  state: "connected" | "error" | "connecting" = "connecting";
  error: string | null = null;

  constructor(
    public cfg: ConnectorConfig,
    private vault: Vault,
  ) {}

  private get e() {
    if (!this.cfg.email) throw new Error("Email settings missing");
    return this.cfg.email;
  }

  private async imap<T>(fn: (c: ImapFlow) => Promise<T>): Promise<T> {
    const pass = this.vault.get(this.e.passwordSecret);
    if (!pass) throw new Error(`Missing secret ${this.e.passwordSecret}`);
    const client = new ImapFlow({
      host: this.e.imapHost,
      port: this.e.imapPort,
      secure: this.e.imapPort === 993,
      auth: { user: this.e.username, pass },
      logger: false,
    });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.logout().catch(() => {});
    }
  }

  async test() {
    try {
      await this.imap(async (c) => c.mailboxOpen("INBOX"));
      this.state = "connected";
      this.error = null;
    } catch (e) {
      this.state = "error";
      this.error = (e as Error).message;
    }
  }

  async search(q: { query?: string; from?: string; unseen?: boolean; sinceDays?: number; limit?: number; mailbox?: string }) {
    return this.imap(async (c) => {
      const lock = await c.getMailboxLock(q.mailbox ?? "INBOX");
      try {
        const crit: Record<string, unknown> = {};
        if (q.unseen) crit.seen = false;
        if (q.from) crit.from = q.from;
        if (q.query) crit.body = q.query;
        crit.since = new Date(Date.now() - (q.sinceDays ?? 14) * 86400_000);
        const uids = ((await c.search(crit, { uid: true })) || []) as number[];
        const pick = uids.slice(-(q.limit ?? 20)).reverse();
        const out: { uid: number; messageId: string; from: string; subject: string; date: string; seen: boolean }[] = [];
        if (!pick.length) return out;
        for await (const m of c.fetch(pick, { envelope: true, flags: true, uid: true }, { uid: true })) {
          out.push({
            uid: m.uid,
            messageId: m.envelope?.messageId ?? String(m.uid),
            from: (m.envelope?.from ?? []).map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", "),
            subject: m.envelope?.subject ?? "(no subject)",
            date: m.envelope?.date ? new Date(m.envelope.date).toISOString() : "",
            seen: m.flags?.has("\\Seen") ?? false,
          });
        }
        return out.sort((a, b) => b.date.localeCompare(a.date));
      } finally {
        lock.release();
      }
    });
  }

  async read(uid: number, mailbox = "INBOX") {
    return this.imap(async (c) => {
      const lock = await c.getMailboxLock(mailbox);
      try {
        const m = await c.fetchOne(String(uid), { source: true, envelope: true }, { uid: true });
        if (!m || !m.source) throw new Error("Message not found");
        return { envelope: m.envelope, body: extractText(m.source.toString("utf8")) };
      } finally {
        lock.release();
      }
    });
  }

  async send(msg: { to: string; cc?: string; subject: string; body: string; inReplyTo?: string }) {
    const pass = this.vault.get(this.e.passwordSecret);
    const t = nodemailer.createTransport({
      host: this.e.smtpHost,
      port: this.e.smtpPort,
      secure: this.e.smtpPort === 465,
      auth: { user: this.e.username, pass: pass ?? "" },
    });
    const info = await t.sendMail({
      from: this.e.address,
      to: msg.to,
      cc: msg.cc,
      subject: msg.subject,
      text: msg.body,
      inReplyTo: msg.inReplyTo,
      references: msg.inReplyTo,
    });
    return info.messageId;
  }

  async draft(msg: { to: string; subject: string; body: string }) {
    const raw = [
      `From: ${this.e.address}`,
      `To: ${msg.to}`,
      `Subject: ${msg.subject}`,
      `Date: ${new Date().toUTCString()}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      msg.body,
    ].join("\r\n");
    return this.imap(async (c) => {
      const boxes = await c.list();
      const drafts = boxes.find((b) => b.specialUse === "\\Drafts")?.path ?? "Drafts";
      await c.append(drafts, raw, ["\\Draft"]);
      return drafts;
    });
  }

  asTools(): Tool[] {
    const id = this.cfg.id;
    const name = this.cfg.name;
    return [
      {
        name: `${id}__search`,
        description: `[${name}] Search email. Returns uid, sender, subject, date. Use read for full bodies.`,
        parameters: obj(
          {
            query: str("Text to search for in the message body"),
            from: str("Sender address or name"),
            unseen: bool("Only unread messages"),
            sinceDays: num("How many days back (default 14)"),
            limit: num("Max results (default 20)"),
          },
          [],
        ),
        risk: "read",
        source: id,
        summarize: (a) => `Searched ${name}${a.query ? ` for “${a.query}”` : a.unseen ? " for unread mail" : ""}`,
        run: async (a) => ({ text: JSON.stringify(await this.search(a as any), null, 1), untrusted: true }),
      },
      {
        name: `${id}__read`,
        description: `[${name}] Read one email by uid.`,
        parameters: obj({ uid: num("Message uid from search") }),
        risk: "read",
        source: id,
        summarize: () => `Read an email in ${name}`,
        run: async (a) => {
          const m = await this.read(Number(a.uid));
          const from = (m.envelope?.from ?? []).map((x) => x.address).join(", ");
          return {
            text: `From: ${from}\nSubject: ${m.envelope?.subject}\nDate: ${m.envelope?.date}\nMessage-ID: ${m.envelope?.messageId}\n\n${truncate(m.body, 20000)}`,
            untrusted: true,
          };
        },
      },
      {
        name: `${id}__save_draft`,
        description: `[${name}] Save a draft in the user's Drafts folder (nothing is sent).`,
        parameters: obj({ to: str("Recipient(s)"), subject: str("Subject"), body: str("Plain-text body") }),
        risk: "internal",
        source: id,
        summarize: (a) => `Drafted email to ${a.to}`,
        run: async (a) => `Saved draft in ${await this.draft(a as any)}.`,
      },
      {
        name: `${id}__send`,
        description: `[${name}] Send an email from ${this.cfg.email?.address}. Requires the user's approval.`,
        parameters: obj(
          {
            to: str("Recipient(s), comma-separated"),
            cc: str("CC recipients"),
            subject: str("Subject"),
            body: str("Plain-text body"),
            inReplyTo: str("Message-ID being replied to, for threading"),
          },
          ["to", "subject", "body"],
        ),
        risk: "external",
        source: id,
        summarize: (a) => `Email to ${a.to}: “${a.subject}”`,
        describe: (a) => ({
          title: `Send email to ${a.to}`,
          preview: `To: ${a.to}${a.cc ? `\nCc: ${a.cc}` : ""}\nSubject: ${a.subject}\n\n${a.body}`,
        }),
        run: async (a) => `Sent. Message-ID ${await this.send(a as any)}`,
      },
    ];
  }
}

/** Very small MIME text extractor: prefers text/plain, falls back to stripped HTML. */
export function extractText(source: string): string {
  const boundary = /boundary="?([^";\r\n]+)"?/i.exec(source)?.[1];
  const decode = (part: string) => {
    const [head, ...rest] = part.split(/\r?\n\r?\n/);
    let body = rest.join("\n\n");
    if (/content-transfer-encoding:\s*base64/i.test(head)) body = Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
    else if (/content-transfer-encoding:\s*quoted-printable/i.test(head))
      body = body.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
    return { head, body };
  };
  if (!boundary) {
    const { head, body } = decode(source);
    return /text\/html/i.test(head) ? stripHtml(body) : body;
  }
  const parts = source.split(`--${boundary}`).slice(1);
  let html = "";
  for (const p of parts) {
    if (/boundary=/i.test(p.split(/\r?\n\r?\n/)[0])) {
      const inner = extractText(p);
      if (inner.trim()) return inner;
    }
    const { head, body } = decode(p.replace(/^\r?\n/, ""));
    if (/content-type:\s*text\/plain/i.test(head)) return body.trim();
    if (/content-type:\s*text\/html/i.test(head)) html = body;
  }
  return stripHtml(html);
}

export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

