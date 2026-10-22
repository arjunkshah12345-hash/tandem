import clsx from "clsx";
import { BookOpen, KeyRound, Pin, PinOff, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { Memory, SkillInfo } from "@shared";
import { Button, Empty, IconButton, Input, Pill, Textarea } from "../../components/ui";
import { timeAgo } from "../../util";
import { api, errText, Section, useSettings } from "./common";

export function MemorySection() {
  const { flash } = useSettings();
  const [q, setQ] = useState("");
  const [list, setList] = useState<Memory[] | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; content: string } | null>(null);
  const load = (query = q) => api.memories(query || undefined).then(setList).catch((e) => flash(errText(e), true));

  useEffect(() => {
    const t = setTimeout(() => void load(q), 200);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <Section
      title="Memory"
      description="What Tandem has learned about you, your work, and your preferences. Shared across every channel. Pinned memories are always in mind; the rest are recalled when relevant."
    >
      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          await api.addMemory(draft.trim(), true);
          setDraft("");
          void load();
        }}
      >
        <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Teach Tandem something: “Invoices go out on the 1st from billing@…”" />
        <Button type="submit" variant="primary" disabled={!draft.trim()}>
          <Plus size={14} /> Add
        </Button>
      </form>
      <div className="relative">
        <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search memories" className="pl-9" />
      </div>
      {list && list.length === 0 ? (
        <Empty icon={<BookOpen size={22} />} title={q ? "No matches" : "Nothing remembered yet"}>
          {q ? null : "Tandem saves durable facts as you work together — people, preferences, recurring deadlines."}
        </Empty>
      ) : (
        <ul className="space-y-2">
          {list?.map((m) => (
            <li key={m.id} className={clsx("group rounded-2xl border bg-card px-4 py-3", m.pinned ? "border-agent/30" : "border-line")}>
              {editing?.id === m.id ? (
                <div className="space-y-2">
                  <Textarea rows={3} value={editing.content} onChange={(e) => setEditing({ ...editing, content: e.target.value })} autoFocus />
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={async () => {
                        await api.updateMemory(m.id, { content: editing.content });
                        setEditing(null);
                        void load();
                      }}
                    >
                      Save
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-2">
                  <button className="min-w-0 flex-1 text-left text-[14px] leading-relaxed" onClick={() => setEditing({ id: m.id, content: m.content })}>
                    {m.content}
                    <span className="mt-1 flex flex-wrap items-center gap-1.5">
                      {m.tags.map((t) => (
                        <Pill key={t}>{t}</Pill>
                      ))}
                      <span className="text-xs text-faint">
                        {timeAgo(m.createdAt)}
                        {m.source ? ` · ${m.source}` : ""}
                      </span>
                    </span>
                  </button>
                  <IconButton
                    label={m.pinned ? "Unpin" : "Pin"}
                    onClick={async () => {
                      await api.updateMemory(m.id, { pinned: !m.pinned });
                      void load();
                    }}
                    className={m.pinned ? "text-agent" : ""}
                  >
                    {m.pinned ? <Pin size={15} /> : <PinOff size={15} />}
                  </IconButton>
                  <IconButton
                    label="Forget"
                    onClick={async () => {
                      await api.deleteMemory(m.id);
                      void load();
                    }}
                  >
                    <Trash2 size={15} />
                  </IconButton>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export function SkillsSection() {
  const [list, setList] = useState<SkillInfo[] | null>(null);
  useEffect(() => {
    api.skills().then(setList).catch(() => setList([]));
  }, []);
  return (
    <Section
      title="Skills"
      description={
        <>
          Playbooks Tandem loads when a job calls for them — the same <code className="rounded bg-sunk px-1 font-mono text-[12px]">SKILL.md</code> format as Claude's Agent Skills. Drop a folder into{" "}
          <code className="rounded bg-sunk px-1 font-mono text-[12px]">~/.tandem/skills</code> to add your own.
        </>
      }
    >
      {list && list.length === 0 ? (
        <Empty icon={<BookOpen size={22} />} title="No skills found" />
      ) : (
        <ul className="space-y-2">
          {list?.map((s) => (
            <li key={s.path} className="rounded-2xl border border-line bg-card px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[13.5px] font-medium">{s.name}</span>
                {s.builtin ? <Pill>built-in</Pill> : <Pill tone="agent">yours</Pill>}
              </div>
              <p className="mt-1 text-[13.5px] text-muted">{s.description}</p>
              <p className="mt-1 truncate font-mono text-[11.5px] text-faint">{s.path}</p>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export function SecretsSection() {
  const { flash } = useSettings();
  const [list, setList] = useState<{ name: string; createdAt: number }[] | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const load = () => api.secrets().then(setList).catch((e) => flash(errText(e), true));
  useEffect(() => {
    void load();
  }, []);

  return (
    <Section
      title="Secrets"
      description={
        <>
          Passwords, API keys and tokens, encrypted at rest. Connectors and the browser reference them as <code className="rounded bg-sunk px-1 font-mono text-[12px]">{"{{secret:NAME}}"}</code>; the model sees the name, never the value, and values are scrubbed from anything it reads back.
        </>
      }
    >
      <form
        className="grid gap-2 sm:grid-cols-[200px_1fr_auto]"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.setSecret(name.trim(), value);
            setName("");
            setValue("");
            flash("Secret saved");
            void load();
          } catch (err) {
            flash(errText(err), true);
          }
        }}
      >
        <Input value={name} onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_.-]/g, "_"))} placeholder="NAME" className="font-mono text-[13px]" />
        <Input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Value" autoComplete="off" />
        <Button type="submit" variant="primary" disabled={!name.trim() || !value}>
          <KeyRound size={14} /> Save
        </Button>
      </form>
      <ul className="divide-y divide-line rounded-2xl border border-line bg-card">
        {list?.length === 0 ? <li className="px-4 py-4 text-sm text-muted">No secrets stored. Keys set as environment variables also work.</li> : null}
        {list?.map((s) => (
          <li key={s.name} className="flex items-center gap-3 px-4 py-2.5">
            <KeyRound size={14} className="text-faint" />
            <span className="flex-1 font-mono text-[13px]">{s.name}</span>
            <span className="text-xs text-faint">{timeAgo(s.createdAt)}</span>
            <IconButton
              label="Delete"
              onClick={async () => {
                if (!confirm(`Delete ${s.name}? Anything using it will stop working.`)) return;
                await api.deleteSecret(s.name);
                void load();
              }}
            >
              <Trash2 size={15} />
            </IconButton>
          </li>
        ))}
      </ul>
    </Section>
  );
}
