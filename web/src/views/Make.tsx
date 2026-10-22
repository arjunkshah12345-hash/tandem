import clsx from "clsx";
import { ArrowLeft, Code2, Download, FileSpreadsheet, FileText, Globe, Pencil, Shapes, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Artifact, ArtifactKind } from "@shared";
import { api } from "../api";
import { Markdown } from "../components/Markdown";
import { Button, Empty, IconButton, Input, Spinner, Textarea } from "../components/ui";
import { useStore } from "../store";
import { navigate, timeAgo, useQueryState } from "../util";

const KIND_ICON: Record<ArtifactKind, React.ReactNode> = {
  html: <Globe size={18} />,
  markdown: <FileText size={18} />,
  csv: <FileSpreadsheet size={18} />,
  json: <Code2 size={18} />,
  code: <Code2 size={18} />,
  text: <FileText size={18} />,
};

export function MakeView() {
  const q = useQueryState();
  const id = q.get("artifact");
  return id ? <ArtifactViewer id={id} /> : <ArtifactGrid />;
}

function ArtifactGrid() {
  const { state } = useStore();
  const [filter, setFilter] = useState("");
  const list = Object.values(state.artifacts)
    .filter((a) => !filter || a.title.toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[1040px] px-4 py-6 md:px-8 md:py-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-[28px] font-semibold tracking-tight">Make</h1>
            <p className="mt-1 text-sm text-muted">Docs, dashboards, tables and pages Tandem has made for you. Ask for edits in the thread or change them here.</p>
          </div>
          {Object.keys(state.artifacts).length > 6 ? <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter…" className="w-56" /> : null}
        </div>
        {list.length === 0 ? (
          <Empty icon={<Shapes size={22} />} title="Nothing made yet">
            Try &ldquo;make me a dashboard of this month's revenue&rdquo; or &ldquo;turn these notes into a one-page brief&rdquo;.
          </Empty>
        ) : (
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {list.map((a) => (
              <button
                key={a.id}
                onClick={() => navigate({ artifact: a.id })}
                className="group flex flex-col rounded-2xl border border-line bg-card p-4 text-left transition hover:-translate-y-0.5 hover:border-agent/40 hover:shadow-[0_12px_32px_-24px_rgba(0,0,0,0.5)]"
              >
                <div className="flex items-center justify-between">
                  <span className="grid size-9 place-items-center rounded-xl bg-agent-soft text-agent">{KIND_ICON[a.kind]}</span>
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">{a.kind}</span>
                </div>
                <div className="mt-4 line-clamp-2 font-display text-[16.5px] font-semibold leading-snug">{a.title}</div>
                <div className="mt-auto pt-3 text-xs text-faint">
                  v{a.version} · {timeAgo(a.updatedAt)}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ArtifactViewer({ id }: { id: string }) {
  const { state } = useStore();
  const live = state.artifacts[id];
  const [a, setA] = useState<Artifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .artifact(id)
      .then(setA)
      .catch((e) => setError(e.message));
  }, [id, live?.version]);

  function startEdit() {
    if (!a) return;
    setDraft(a.content ?? "");
    setTitle(a.title);
    setEditing(true);
  }

  async function save() {
    setBusy(true);
    try {
      setA(await api.saveArtifact(id, { title, content: draft }));
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm("Delete this artifact?")) return;
    await api.deleteArtifact(id);
    navigate({ artifact: null });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3 md:px-5">
        <IconButton label="Back" onClick={() => navigate({ artifact: null })}>
          <ArrowLeft size={18} />
        </IconButton>
        <div className="min-w-0 flex-1">
          <div className="truncate font-display text-[16px] font-semibold">{a?.title ?? live?.title ?? "…"}</div>
          {a ? (
            <div className="text-[11.5px] text-faint">
              {a.kind} · v{a.version} · {timeAgo(a.updatedAt)}
            </div>
          ) : null}
        </div>
        {a && !editing ? (
          <>
            <IconButton label="Edit" onClick={startEdit}>
              <Pencil size={16} />
            </IconButton>
            <a href={`/api/artifacts/${id}/raw?download=1`} className="inline-grid size-9 place-items-center rounded-full text-muted hover:bg-sunk hover:text-ink" title="Download" aria-label="Download">
              <Download size={16} />
            </a>
            <IconButton label="Delete" onClick={remove}>
              <Trash2 size={16} />
            </IconButton>
          </>
        ) : null}
        {editing ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" busy={busy} onClick={save}>
              Save
            </Button>
          </>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">
        {error ? (
          <p className="p-6 text-sm text-danger">{error}</p>
        ) : !a ? (
          <div className="flex justify-center py-16 text-faint">
            <Spinner />
          </div>
        ) : editing ? (
          <div className="flex h-full flex-col gap-3 p-4 md:p-6">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
            <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} className="min-h-0 flex-1 resize-none font-mono text-[13px]" spellCheck={a.kind === "markdown" || a.kind === "text"} />
          </div>
        ) : (
          <ArtifactBody artifact={a} />
        )}
      </div>
    </div>
  );
}

function ArtifactBody({ artifact: a }: { artifact: Artifact }) {
  if (a.kind === "html")
    return (
      // Served with a CSP sandbox (opaque origin) — the iframe sandbox is a second layer.
      <iframe
        key={a.version}
        src={`/api/artifacts/${a.id}/raw?v=${a.version}`}
        sandbox="allow-scripts allow-popups allow-forms allow-modals"
        className="h-full w-full border-0 bg-white"
        title={a.title}
      />
    );
  return (
    <div className="scroll-thin h-full overflow-auto">
      <div className={clsx("mx-auto px-4 py-6 md:px-8 md:py-10", a.kind === "csv" ? "max-w-none" : "max-w-[760px]")}>
        {a.kind === "markdown" ? (
          <Markdown className="text-[15.5px]">{a.content ?? ""}</Markdown>
        ) : a.kind === "csv" ? (
          <CsvTable text={a.content ?? ""} />
        ) : (
          <pre className="whitespace-pre-wrap rounded-2xl bg-sunk p-4 font-mono text-[13px] leading-relaxed">{a.kind === "json" ? prettyJson(a.content ?? "") : a.content}</pre>
        )}
      </div>
    </div>
  );
}

function prettyJson(s: string) {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

/** RFC-4180-ish CSV parser (quotes, escaped quotes, newlines in fields). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function CsvTable({ text }: { text: string }) {
  const rows = useMemo(() => parseCsv(text.trim()), [text]);
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  if (!rows.length) return <p className="text-sm text-muted">Empty table.</p>;
  const [head, ...body] = rows;
  const sorted = sort
    ? [...body].sort((x, y) => {
        const a = x[sort.col] ?? "";
        const b = y[sort.col] ?? "";
        const na = Number(a.replace(/[$,%]/g, ""));
        const nb = Number(b.replace(/[$,%]/g, ""));
        const cmp = !Number.isNaN(na) && !Number.isNaN(nb) && a !== "" && b !== "" ? na - nb : a.localeCompare(b);
        return cmp * sort.dir;
      })
    : body;
  return (
    <div className="overflow-x-auto rounded-2xl border border-line bg-card">
      <table className="w-full text-[13.5px]">
        <thead>
          <tr className="border-b border-line bg-sunk/60">
            {head.map((h, i) => (
              <th
                key={i}
                onClick={() => setSort((s) => (s?.col === i ? { col: i, dir: s.dir === 1 ? -1 : 1 } : { col: i, dir: 1 }))}
                className="cursor-pointer whitespace-nowrap px-3 py-2 text-left font-semibold text-muted hover:text-ink"
              >
                {h}
                {sort?.col === i ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => (
            <tr key={i} className="border-b border-line last:border-0">
              {head.map((_, j) => (
                <td key={j} className={clsx("px-3 py-2", /^[-$\d.,%\s]+$/.test(r[j] ?? "") && "text-right tabular-nums")}>
                  {r[j]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
