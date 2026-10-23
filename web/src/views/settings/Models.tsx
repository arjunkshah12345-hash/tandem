import clsx from "clsx";
import { Check, ChevronDown, KeyRound, Plus, X, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import type { ProviderConfig } from "@shared";
import { Button, Field, IconButton, Input, Pill, Select, Toggle } from "../../components/ui";
import { api, CommitInput, errText, Group, Row, Section, useSettings } from "./common";

// Only suggest ids we know exist; for other providers use "List available models".
const SUGGESTED: Record<string, string[]> = {
  anthropic: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"],
};

export function ModelsSection() {
  const { settings: s, save, flash } = useSettings();
  const [data, setData] = useState<Awaited<ReturnType<typeof api.providers>> | null>(null);
  const load = () => api.providers().then(setData).catch((e) => flash(errText(e), true));
  useEffect(() => {
    void load();
  }, []);

  const enabled = data?.providers.filter((p) => p.enabled) ?? [];
  const options = enabled.flatMap((p) => (SUGGESTED[p.id] ?? []).map((m) => `${p.id}:${m}`));

  return (
    <Section
      title="Models"
      description="Use any provider — Anthropic, OpenAI, Google, open models via OpenRouter, Groq or Together, or fully local with Ollama. Pick a strong model for real work and a cheap one for the frequent background check-ins."
    >
      <datalist id="model-options">
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
      <Group title="Routing">
        <ModelRow label="Work model" hint="Chat, tasks, briefs. Use your best model." value={s.models.work} onCommit={(v) => save({ models: { work: v } })} />
        <ModelRow label="Triage model" hint="Check-ins, summaries, the safety reviewer. Fast and cheap." value={s.models.triage} onCommit={(v) => save({ models: { triage: v } })} />
        <Row label="Fallbacks" hint="Tried in order if the work model errors or is overloaded. Comma-separated.">
          <CommitInput
            value={s.models.fallbacks.join(", ")}
            onCommit={(v) => save({ models: { fallbacks: v.split(",").map((x) => x.trim()).filter(Boolean) } })}
            placeholder="anthropic:claude-sonnet-5-5, ollama:<model>"
            className="font-mono text-[13px] @lg:w-80"
          />
        </Row>
      </Group>

      <CompressionGroup />

      <div>
        <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.08em] text-faint">Providers</h3>
        <div className="space-y-2">
          {data?.providers.map((p) => (
            <ProviderCard key={p.id} p={p} hasKey={data.keyPresent[p.id]} onChange={load} />
          ))}
          <AddProvider onAdded={load} />
        </div>
      </div>
    </Section>
  );
}

function ModelRow({ label, hint, value, onCommit }: { label: string; hint: string; value: string; onCommit: (v: string) => void }) {
  const [test, setTest] = useState<{ busy: boolean; result?: string; ok?: boolean }>({ busy: false });
  async function run() {
    const i = value.indexOf(":");
    if (i < 1) return;
    setTest({ busy: true });
    const r = await api.testModel(value.slice(0, i), value.slice(i + 1)).catch((e) => ({ ok: false, error: errText(e), latencyMs: 0, reply: undefined }));
    setTest({ busy: false, ok: r.ok, result: r.ok ? `Replied in ${(r.latencyMs / 1000).toFixed(1)}s` : r.error });
  }
  return (
    <Row label={label} hint={test.result ? <span className={test.ok ? "text-ok" : "text-danger"}>{test.result}</span> : hint}>
      <div className="flex items-center gap-1.5">
        <CommitInput value={value} onCommit={onCommit} list="model-options" className="font-mono text-[13px] @lg:w-72" spellCheck={false} />
        <Button size="sm" variant="quiet" busy={test.busy} onClick={run} title="Send a test message">
          {test.busy ? null : <Zap size={13} />} Test
        </Button>
      </div>
    </Row>
  );
}

function ProviderCard({ p, hasKey, onChange }: { p: ProviderConfig; hasKey: boolean; onChange: () => void }) {
  const { flash } = useSettings();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [models, setModels] = useState<string[] | null>(null);
  const [modelsErr, setModelsErr] = useState<string | null>(null);
  const local = !p.apiKeySecret;

  async function saveP(patch: Partial<ProviderConfig>) {
    try {
      await api.saveProvider({ ...p, ...patch });
      onChange();
    } catch (e) {
      flash(errText(e), true);
    }
  }

  async function saveKey() {
    if (!key.trim() || !p.apiKeySecret) return;
    try {
      await api.setSecret(p.apiKeySecret, key.trim());
      setKey("");
      await saveP({ enabled: true });
      flash(`${p.label} key saved`);
    } catch (e) {
      flash(errText(e), true);
    }
  }

  async function listModels() {
    setModelsErr(null);
    const r = await api.models(p.id);
    setModels(r.models);
    if (r.error) setModelsErr(r.error);
  }

  return (
    <div className={clsx("rounded-2xl border bg-card transition", p.enabled ? "border-agent/30" : "border-line")}>
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <span className={clsx("size-2 rounded-full", p.enabled && hasKey ? "bg-ok" : "bg-line")} />
        <span className="flex-1 text-sm font-medium">{p.label}</span>
        <span className="hidden font-mono text-xs text-faint sm:inline">{p.id}</span>
        {p.enabled ? <Pill tone="agent">On</Pill> : hasKey && !local ? <Pill>Key set</Pill> : null}
        <ChevronDown size={16} className={clsx("text-faint transition", open && "rotate-180")} />
      </button>
      {open ? (
        <div className="space-y-4 border-t border-line px-4 py-4">
          <Toggle checked={p.enabled} onChange={(v) => saveP({ enabled: v })} label="Enabled" hint={`Use as ${p.id}:<model> in routing.`} />
          {!local ? (
            <Field label="API key" hint={hasKey ? `A key is stored as ${p.apiKeySecret} (or set in the environment). Paste a new one to replace it.` : `Stored encrypted as ${p.apiKeySecret}. Never shown to the model.`}>
              <div className="flex gap-2">
                <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={hasKey ? "••••••••••••" : "Paste key"} autoComplete="off" />
                <Button variant="primary" disabled={!key.trim()} onClick={saveKey}>
                  <KeyRound size={14} /> Save
                </Button>
              </div>
            </Field>
          ) : null}
          <Field label="Base URL">
            <CommitInput value={p.baseUrl} onCommit={(v) => saveP({ baseUrl: v })} className="font-mono text-[13px]" spellCheck={false} />
          </Field>
          <div>
            <Button size="sm" onClick={listModels}>
              List available models
            </Button>
            {modelsErr ? <p className="mt-2 text-[13px] text-danger">{modelsErr}</p> : null}
            {models?.length ? (
              <div className="scroll-thin mt-2 max-h-48 overflow-y-auto rounded-xl bg-sunk p-2 font-mono text-[12px]">
                {models.map((m) => (
                  <div key={m} className="flex items-center justify-between px-1.5 py-0.5">
                    <span className="truncate">{m}</span>
                    <button className="text-agent hover:underline" onClick={() => navigator.clipboard.writeText(`${p.id}:${m}`).then(() => flash("Copied model ref"))}>
                      copy
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          {!PRESET_IDS.has(p.id) ? (
            <Button
              size="sm"
              variant="danger"
              onClick={async () => {
                await api.deleteProvider(p.id);
                onChange();
              }}
            >
              Remove provider
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const PRESET_IDS = new Set(["anthropic", "openai", "gemini", "openrouter", "xai", "mistral", "deepseek", "groq", "together", "fireworks", "cerebras", "moonshot", "azure", "ollama", "lmstudio", "custom"]);

function AddProvider({ onAdded }: { onAdded: () => void }) {
  const { flash } = useSettings();
  const [open, setOpen] = useState(false);
  const [d, setD] = useState({ id: "", label: "", kind: "openai" as ProviderConfig["kind"], baseUrl: "", key: "" });
  if (!open)
    return (
      <button onClick={() => setOpen(true)} className="flex w-full items-center justify-center gap-1.5 rounded-2xl border border-dashed border-line py-3 text-sm text-muted hover:text-ink">
        <Plus size={15} /> Add another endpoint
      </button>
    );
  return (
    <div className="space-y-3 rounded-2xl border border-line bg-card p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">New provider</span>
        <IconButton label="Close" onClick={() => setOpen(false)}>
          <X size={16} />
        </IconButton>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Id">
          <Input value={d.id} onChange={(e) => setD({ ...d, id: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "") })} placeholder="vllm" />
        </Field>
        <Field label="Name">
          <Input value={d.label} onChange={(e) => setD({ ...d, label: e.target.value })} placeholder="Office GPU box" />
        </Field>
        <Field label="Protocol">
          <Select
            value={d.kind}
            onChange={(v) => setD({ ...d, kind: v as ProviderConfig["kind"] })}
            options={[
              { value: "openai", label: "OpenAI-compatible" },
              { value: "anthropic", label: "Anthropic Messages" },
              { value: "gemini", label: "Gemini" },
            ]}
          />
        </Field>
        <Field label="Base URL">
          <Input value={d.baseUrl} onChange={(e) => setD({ ...d, baseUrl: e.target.value })} placeholder="http://10.0.0.5:8000/v1" />
        </Field>
      </div>
      <Field label="API key (optional)">
        <Input type="password" value={d.key} onChange={(e) => setD({ ...d, key: e.target.value })} autoComplete="off" />
      </Field>
      <Button
        variant="primary"
        disabled={!d.id || !d.baseUrl}
        onClick={async () => {
          try {
            const secret = d.key ? `${d.id.toUpperCase().replace(/-/g, "_")}_API_KEY` : null;
            if (secret) await api.setSecret(secret, d.key);
            await api.saveProvider({ id: d.id, label: d.label || d.id, kind: d.kind, baseUrl: d.baseUrl, apiKeySecret: secret, enabled: true });
            setOpen(false);
            setD({ id: "", label: "", kind: "openai", baseUrl: "", key: "" });
            onAdded();
          } catch (e) {
            flash(errText(e), true);
          }
        }}
      >
        <Check size={14} /> Add provider
      </Button>
    </div>
  );
}

function fmtTokens(n: number) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}

/** SuperCompress: query-aware compression of large tool results via the hosted API. */
function CompressionGroup() {
  const { settings: s, save, flash } = useSettings();
  const c = s.compression;
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.compression>> | null>(null);
  const [key, setKey] = useState("");
  const [test, setTest] = useState<{ busy: boolean; text?: string; ok?: boolean }>({ busy: false });
  const load = () => api.compression().then(setStatus).catch(() => {});
  useEffect(() => {
    void load();
  }, []);

  async function saveKey() {
    try {
      await api.setSecret("SUPERCOMPRESS_API_KEY", key.trim());
      setKey("");
      flash("SuperCompress key saved");
      void load();
    } catch (e) {
      flash(errText(e), true);
    }
  }

  async function runTest() {
    setTest({ busy: true });
    const r = await api.testCompression().catch((e) => ({ ok: false, error: errText(e), latencyMs: 0 }) as { ok: boolean; error?: string; latencyMs: number; originalTokens?: number; keptTokens?: number });
    setTest({
      busy: false,
      ok: r.ok,
      text: r.ok ? `Working — ${r.originalTokens} → ${r.keptTokens} tokens in ${(r.latencyMs / 1000).toFixed(1)}s` : r.error,
    });
    void load();
  }

  const saved30 = status ? status.last30.originalTokens - status.last30.keptTokens : 0;
  const pct30 = status && status.last30.originalTokens ? Math.round((saved30 / status.last30.originalTokens) * 100) : 0;

  return (
    <Group
      title="Context compression · SuperCompress"
      action={
        <a href="https://www.supercompress.dev" target="_blank" rel="noopener noreferrer" className="text-[12px] text-agent hover:underline">
          supercompress.dev ↗
        </a>
      }
    >
      <Toggle
        checked={c.enabled}
        onChange={(v) => save({ compression: { enabled: v } })}
        label="Compress large tool results"
        hint="Web pages, emails, connector output and browser snapshots are cut to the lines that answer the current request — kept lines are verbatim, never rewritten. Secrets are removed before anything is sent, and the agent can always fetch the full original."
      />
      <Row
        label="API key"
        hint={
          status?.configured ? (
            <span className="text-ok">Key saved (or set via SUPERCOMPRESS_API_KEY).</span>
          ) : (
            <>
              Free monthly allowance —{" "}
              <a href="https://www.supercompress.dev/dashboard" target="_blank" rel="noopener noreferrer" className="text-agent underline">
                get a key
              </a>
              .
            </>
          )
        }
      >
        <div className="flex gap-2">
          <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={status?.configured ? "••••••••" : "sc_live_…"} autoComplete="off" className="@lg:w-56" />
          <Button variant="primary" disabled={!key.trim()} onClick={saveKey}>
            <KeyRound size={14} /> Save
          </Button>
        </div>
      </Row>
      <Row label="Where" hint="The hosted model takes about 40–50s per call, so live chat is skipped by default.">
        <Select
          value={c.scope}
          onChange={(v) => save({ compression: { scope: v as "background" | "all" } })}
          options={[
            { value: "background", label: "Background & tasks" },
            { value: "all", label: "Everywhere, incl. live chat" },
          ]}
          className="@lg:w-56"
        />
      </Row>
      <Row label="Only results longer than" hint="Characters. Smaller results go to the model as-is.">
        <CommitInput
          type="number"
          min={1000}
          step={1000}
          value={String(c.minChars)}
          onCommit={(v) => save({ compression: { minChars: Math.max(1000, Number(v) || 6000) } })}
          className="@lg:w-32"
        />
      </Row>
      <Row
        label="Status"
        hint={
          test.text ? (
            <span className={test.ok ? "text-ok" : "text-danger"}>{test.text}</span>
          ) : status?.paused ? (
            <span className="text-danger">{status.paused}</span>
          ) : status && status.last30.calls ? (
            `Saved ${fmtTokens(saved30)} tokens (${pct30}%) over ${status.last30.calls} results in the last 30 days · today ${fmtTokens(status.today.originalTokens - status.today.keptTokens)}`
          ) : (
            "No results compressed yet."
          )
        }
      >
        <Button size="sm" variant="quiet" busy={test.busy} disabled={!status?.configured} onClick={runTest}>
          {test.busy ? "Testing…" : <><Zap size={13} /> Test</>}
        </Button>
      </Row>
    </Group>
  );
}
