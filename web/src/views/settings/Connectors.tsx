import clsx from "clsx";
import { ChevronDown, ExternalLink, LogIn, Plug, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { CatalogEntry, ConnectorConfig, ConnectorStatus, RiskLevel } from "@shared";
import { Button, Field, Input, Pill, RiskBadge, Select, Sheet, Textarea, Toggle } from "../../components/ui";
import { useStore } from "../../store";
import { api, errText, Section, useSettings } from "./common";

type Data = Awaited<ReturnType<typeof api.connectors>>;

const STATE: Record<ConnectorStatus["state"], { label: string; tone: "ok" | "muted" | "danger" | "accent" | "agent" }> = {
  connected: { label: "Connected", tone: "ok" },
  connecting: { label: "Connecting…", tone: "muted" },
  error: { label: "Error", tone: "danger" },
  disabled: { label: "Off", tone: "muted" },
  needs_auth: { label: "Sign in needed", tone: "accent" },
};

export function ConnectorsSection() {
  const { flash } = useSettings();
  const { state } = useStore();
  const [data, setData] = useState<Data | null>(null);
  const [adding, setAdding] = useState<{ entry: CatalogEntry; existing?: ConnectorConfig } | null>(null);
  const load = () => api.connectors().then(setData).catch((e) => flash(errText(e), true));
  useEffect(() => {
    void load();
  }, []);
  // Live status from SSE wins over the snapshot.
  const statusOf = (id: string) => state.connectors[id] ?? data?.status.find((s) => s.id === id);

  const categories = [...new Set(data?.catalog.map((c) => c.category) ?? [])];

  return (
    <Section
      title="Connected apps"
      description={
        <>
          Anything that speaks the Model Context Protocol works — thousands of servers, plus Zapier and Composio for everything else. Credentials live in the encrypted vault and are never shown to the model.
        </>
      }
    >
      {data?.connectors.length ? (
        <div className="space-y-2">
          {data.connectors.map((c) => (
            <ConnectorCard
              key={c.id}
              config={c}
              status={statusOf(c.id)}
              onChange={load}
              onEdit={() => setAdding({ entry: data.catalog.find((e) => e.template.type === c.type) ?? data.catalog[data.catalog.length - 1], existing: c })}
            />
          ))}
        </div>
      ) : data ? (
        <div className="rounded-2xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">Nothing connected yet. Email and calendar are the best place to start.</div>
      ) : null}

      {categories.map((cat) => (
        <div key={cat}>
          <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.08em] text-faint">{cat}</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {data!.catalog
              .filter((e) => e.category === cat)
              .map((e) => (
                <button key={e.id} onClick={() => setAdding({ entry: e })} className="rounded-2xl border border-line bg-card p-3.5 text-left transition hover:border-agent/40">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Plug size={14} className="text-agent" />
                    {e.name}
                  </div>
                  <p className="mt-1 line-clamp-2 text-[12.5px] leading-snug text-muted">{e.description}</p>
                </button>
              ))}
          </div>
        </div>
      ))}

      {adding ? (
        <ConnectorForm
          entry={adding.entry}
          existing={adding.existing}
          takenIds={data?.connectors.map((c) => c.id) ?? []}
          onClose={() => setAdding(null)}
          onSaved={() => {
            setAdding(null);
            void load();
          }}
        />
      ) : null}
    </Section>
  );
}

function ConnectorCard({ config: c, status, onChange, onEdit }: { config: ConnectorConfig; status?: ConnectorStatus; onChange: () => void; onEdit: () => void }) {
  const { flash } = useSettings();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const st = STATE[status?.state ?? "connecting"];

  async function update(patch: Partial<ConnectorConfig>) {
    try {
      await api.saveConnector({ ...c, ...patch });
      onChange();
    } catch (e) {
      flash(errText(e), true);
    }
  }

  return (
    <div className="rounded-2xl border border-line bg-card">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{c.name}</span>
          <span className="block truncate text-xs text-faint">
            {c.type === "email" ? c.email?.address : c.type === "mcp-http" ? c.url : c.type === "mcp-stdio" ? `${c.command} ${(c.args ?? []).join(" ")}` : "Calendar feed"}
          </span>
        </span>
        {status?.tools.length ? <span className="hidden text-xs text-faint sm:inline">{status.tools.length} tools</span> : null}
        <Pill tone={st.tone}>{st.label}</Pill>
        <ChevronDown size={16} className={clsx("text-faint transition", open && "rotate-180")} />
      </button>
      {status?.state === "needs_auth" && status.authUrl ? (
        <div className="px-4 pb-3">
          <a href={status.authUrl} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-full bg-accent px-3 text-[13px] font-medium text-white">
            <LogIn size={14} /> Sign in to {c.name}
          </a>
        </div>
      ) : null}
      {status?.error && status.state === "error" ? <p className="px-4 pb-3 text-[13px] text-danger">{status.error}</p> : null}
      {open ? (
        <div className="border-t border-line px-4 py-3">
          <Toggle checked={c.enabled} onChange={(v) => update({ enabled: v })} label="Enabled" />
          {status?.tools.length ? (
            <div className="mt-2">
              <div className="mb-1.5 text-[12px] font-medium text-muted">Tools — adjust what needs approval, or hide a tool entirely</div>
              <div className="scroll-thin max-h-80 space-y-0.5 overflow-y-auto">
                {status.tools.map((t) => {
                  const hidden = c.disabledTools?.includes(t.name);
                  return (
                    <div key={t.name} className="flex items-center gap-2 rounded-lg px-1.5 py-1.5 hover:bg-sunk/60">
                      <div className="min-w-0 flex-1">
                        <div className={clsx("truncate font-mono text-[12.5px]", hidden && "text-faint line-through")}>{t.name}</div>
                        <div className="truncate text-[12px] text-faint">{t.description}</div>
                      </div>
                      <RiskBadge risk={c.riskOverrides?.[t.name] ?? t.risk} />
                      <select
                        aria-label="Risk override"
                        value={c.riskOverrides?.[t.name] ?? ""}
                        onChange={(e) => {
                          const ro = { ...(c.riskOverrides ?? {}) };
                          if (e.target.value) ro[t.name] = e.target.value as RiskLevel;
                          else delete ro[t.name];
                          void update({ riskOverrides: ro });
                        }}
                        className="h-7 rounded-lg border border-line bg-card px-1 text-[12px]"
                      >
                        <option value="">auto</option>
                        {(["read", "internal", "external", "payment", "sign", "delete", "forbidden"] as RiskLevel[]).map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                      <input
                        type="checkbox"
                        title="Available to Tandem"
                        checked={!hidden}
                        onChange={(e) => {
                          const set = new Set(c.disabledTools ?? []);
                          if (e.target.checked) set.delete(t.name);
                          else set.add(t.name);
                          void update({ disabledTools: [...set] });
                        }}
                        className="size-4 accent-[var(--agent)]"
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              busy={busy}
              onClick={async () => {
                setBusy(true);
                await api.reconnect(c.id).catch((e) => flash(errText(e), true));
                setBusy(false);
                onChange();
              }}
            >
              <RefreshCw size={13} /> Reconnect
            </Button>
            <Button size="sm" onClick={onEdit}>
              Edit
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={async () => {
                if (!confirm(`Disconnect ${c.name}?`)) return;
                await api.deleteConnector(c.id);
                onChange();
              }}
            >
              <Trash2 size={13} /> Remove
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function kv(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of s.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}
const unkv = (r?: Record<string, string>) =>
  Object.entries(r ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

const EMAIL_PRESETS: Record<string, { imapHost: string; smtpHost: string }> = {
  Gmail: { imapHost: "imap.gmail.com", smtpHost: "smtp.gmail.com" },
  Fastmail: { imapHost: "imap.fastmail.com", smtpHost: "smtp.fastmail.com" },
  iCloud: { imapHost: "imap.mail.me.com", smtpHost: "smtp.mail.me.com" },
  "Outlook.com": { imapHost: "outlook.office365.com", smtpHost: "smtp-mail.outlook.com" },
  Yahoo: { imapHost: "imap.mail.yahoo.com", smtpHost: "smtp.mail.yahoo.com" },
};

function ConnectorForm({
  entry,
  existing,
  takenIds,
  onClose,
  onSaved,
}: {
  entry: CatalogEntry;
  existing?: ConnectorConfig;
  takenIds: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const base: ConnectorConfig = existing ?? {
    ...structuredClone(entry.template),
    id: uniqueId(entry.id, takenIds),
    enabled: true,
  };
  const [cfg, setCfg] = useState<ConnectorConfig>(base);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [args, setArgs] = useState((base.args ?? []).join("\n"));
  const [env, setEnv] = useState(unkv(base.env));
  const [headers, setHeaders] = useState(unkv(base.headers));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = cfg.type;
  // A second connector from the same template gets its own secret names (EMAIL_PASSWORD_EMAIL_2, …).
  const secretName = (name: string) => (existing || cfg.id === entry.id ? name : `${name}_${cfg.id.toUpperCase()}`);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      for (const [name, value] of Object.entries(secrets)) if (value.trim()) await api.setSecret(secretName(name), value.trim());
      let out: ConnectorConfig = { ...cfg };
      if (t === "mcp-stdio") {
        out.args = args.split("\n").map((a) => a.trim()).filter(Boolean);
        out.env = kv(env);
      }
      if (t === "mcp-http") out.headers = kv(headers);
      if (t === "email" && out.email && !out.email.username) out.email = { ...out.email, username: out.email.address };
      if (!existing && cfg.id !== entry.id) {
        let json = JSON.stringify(out);
        for (const s of entry.secrets) json = json.replaceAll(`{{secret:${s.name}}}`, `{{secret:${secretName(s.name)}}}`).replaceAll(`"${s.name}"`, `"${secretName(s.name)}"`);
        out = JSON.parse(json);
      }
      await api.saveConnector(out);
      onSaved();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  const email = cfg.email;
  const setEmail = (p: Partial<NonNullable<ConnectorConfig["email"]>>) => setCfg({ ...cfg, email: { ...email!, ...p } });

  return (
    <Sheet open onClose={onClose} title={existing ? `Edit ${existing.name}` : `Connect ${entry.name}`}>
      <div className="space-y-4 p-5">
        <p className="text-sm text-muted">{entry.description}</p>
        {entry.docsUrl ? (
          <a href={entry.docsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[13px] text-agent hover:underline">
            Setup guide <ExternalLink size={12} />
          </a>
        ) : null}
        <Field label="Name">
          <Input value={cfg.name} onChange={(e) => setCfg({ ...cfg, name: e.target.value })} />
        </Field>

        {t === "email" && email ? (
          <>
            <Field label="Email address">
              <Input type="email" value={email.address} onChange={(e) => setEmail({ address: e.target.value })} placeholder="you@company.com" />
            </Field>
            <Field label="Provider">
              <Select
                value={Object.entries(EMAIL_PRESETS).find(([, v]) => v.imapHost === email.imapHost)?.[0] ?? "Other"}
                onChange={(v) => EMAIL_PRESETS[v] && setEmail({ ...EMAIL_PRESETS[v], imapPort: 993, smtpPort: 465 })}
                options={[...Object.keys(EMAIL_PRESETS), "Other"].map((k) => ({ value: k, label: k }))}
              />
            </Field>
            <div className="grid grid-cols-[1fr_90px] gap-2">
              <Field label="IMAP host">
                <Input value={email.imapHost} onChange={(e) => setEmail({ imapHost: e.target.value })} />
              </Field>
              <Field label="Port">
                <Input type="number" value={email.imapPort} onChange={(e) => setEmail({ imapPort: Number(e.target.value) })} />
              </Field>
              <Field label="SMTP host">
                <Input value={email.smtpHost} onChange={(e) => setEmail({ smtpHost: e.target.value })} />
              </Field>
              <Field label="Port">
                <Input type="number" value={email.smtpPort} onChange={(e) => setEmail({ smtpPort: Number(e.target.value) })} />
              </Field>
            </div>
            <Field label="Username" hint="Usually your email address.">
              <Input value={email.username} onChange={(e) => setEmail({ username: e.target.value })} placeholder={email.address} />
            </Field>
          </>
        ) : null}

        {t === "mcp-http" ? (
          <>
            <Field label="Server URL">
              <Input value={cfg.url ?? ""} onChange={(e) => setCfg({ ...cfg, url: e.target.value })} className="font-mono text-[13px]" />
            </Field>
            <Field label="Headers" hint="One per line, NAME=value. Use {{secret:NAME}} for tokens. Leave empty to sign in with OAuth.">
              <Textarea rows={2} value={headers} onChange={(e) => setHeaders(e.target.value)} className="font-mono text-[12.5px]" spellCheck={false} />
            </Field>
          </>
        ) : null}

        {t === "mcp-stdio" ? (
          <>
            <Field label="Command">
              <Input value={cfg.command ?? ""} onChange={(e) => setCfg({ ...cfg, command: e.target.value })} className="font-mono text-[13px]" />
            </Field>
            <Field label="Arguments" hint="One per line.">
              <Textarea rows={3} value={args} onChange={(e) => setArgs(e.target.value)} className="font-mono text-[12.5px]" spellCheck={false} />
            </Field>
            <Field label="Environment" hint="NAME=value per line. Use {{secret:NAME}} for credentials.">
              <Textarea rows={2} value={env} onChange={(e) => setEnv(e.target.value)} className="font-mono text-[12.5px]" spellCheck={false} />
            </Field>
          </>
        ) : null}

        {existing ? (
          <p className="text-[13px] text-muted">To change a password or token, replace it under Settings → Secrets.</p>
        ) : (
          entry.secrets.map((s) => (
            <Field key={s.name} label={s.label} hint={s.help ?? `Saved encrypted as ${secretName(s.name)}.`}>
              <Input type="password" autoComplete="off" value={secrets[s.name] ?? ""} onChange={(e) => setSecrets({ ...secrets, [s.name]: e.target.value })} />
            </Field>
          ))
        )}

        {error ? <p className="text-sm text-danger">{error}</p> : null}
        <Button variant="primary" className="w-full" busy={busy} onClick={submit}>
          {existing ? "Save" : "Connect"}
        </Button>
      </div>
    </Sheet>
  );
}

function uniqueId(base: string, taken: string[]) {
  const clean = base.replace(/[^a-z0-9_]/g, "_");
  if (!taken.includes(clean)) return clean;
  let n = 2;
  while (taken.includes(`${clean}_${n}`)) n++;
  return `${clean}_${n}`;
}
