import { useEffect, useState } from "react";
import type { UsageSummary } from "@shared";
import { Spinner } from "../../components/ui";
import { usd } from "../../util";
import { api, Section, useSettings } from "./common";

export function UsageSection() {
  const { settings } = useSettings();
  const [u, setU] = useState<UsageSummary | null>(null);
  useEffect(() => {
    api.usage().then(setU).catch(() => {});
  }, []);
  if (!u)
    return (
      <div className="flex justify-center py-16 text-faint">
        <Spinner />
      </div>
    );
  const cap = settings.budget.dailyBackgroundUsd;
  const total30 = u.last30.reduce((n, d) => n + d.usd, 0);

  return (
    <Section title="Usage" description="Estimated from token counts and public list prices. Your provider's bill is the source of truth.">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Today" value={usd(u.today.usd)} sub={`${fmt(u.today.inputTokens)} in · ${fmt(u.today.outputTokens)} out`} />
        <Stat label="Background today" value={usd(u.today.backgroundUsd)} sub={cap ? `of ${usd(cap)} daily cap` : "no cap"} bar={cap ? u.today.backgroundUsd / cap : undefined} />
        <Stat label="Last 30 days" value={usd(total30)} sub={`${usd(total30 / 30)} / day avg`} />
      </div>
      <Chart days={u.last30} />
      <div>
        <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.08em] text-faint">By model (30 days)</h3>
        <div className="divide-y divide-line rounded-2xl border border-line bg-card">
          {u.byModel.length === 0 ? <p className="px-4 py-4 text-sm text-muted">No model calls yet.</p> : null}
          {u.byModel.map((m) => (
            <div key={m.model} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{m.model}</span>
              <span className="text-xs text-faint">{m.calls} calls</span>
              <span className="w-20 text-right tabular-nums">{usd(m.usd)}</span>
            </div>
          ))}
        </div>
      </div>
    </Section>
  );
}

function fmt(n: number) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}

function Stat({ label, value, sub, bar }: { label: string; value: string; sub: string; bar?: number }) {
  return (
    <div className="rounded-2xl border border-line bg-card px-4 py-3.5">
      <div className="text-[12px] font-medium text-muted">{label}</div>
      <div className="mt-1 font-display text-[26px] font-semibold tabular-nums tracking-tight">{value}</div>
      <div className="text-xs text-faint">{sub}</div>
      {bar !== undefined ? (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-sunk">
          <div className={`h-full rounded-full ${bar >= 1 ? "bg-danger" : bar > 0.8 ? "bg-accent" : "bg-agent"}`} style={{ width: `${Math.min(100, bar * 100)}%` }} />
        </div>
      ) : null}
    </div>
  );
}

function Chart({ days }: { days: UsageSummary["last30"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(0.01, ...days.map((d) => d.usd));
  const W = 600;
  const H = 140;
  const bw = W / Math.max(days.length, 1);
  const h = hover !== null ? days[hover] : null;
  return (
    <div className="rounded-2xl border border-line bg-card p-4">
      <div className="mb-3 flex items-baseline justify-between text-[12.5px]">
        <span className="font-medium text-muted">Daily spend</span>
        <span className="flex items-center gap-3 text-faint">
          {h ? (
            <span className="text-ink">
              {h.day}: {usd(h.usd)} ({usd(h.background)} background)
            </span>
          ) : (
            <>
              <Legend cls="bg-agent" label="You asked" />
              <Legend cls="bg-accent" label="Background" />
            </>
          )}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-36 w-full" preserveAspectRatio="none" onMouseLeave={() => setHover(null)}>
        {days.map((d, i) => {
          const total = (d.usd / max) * (H - 4);
          const bg = (d.background / max) * (H - 4);
          const x = i * bw + bw * 0.15;
          const w = bw * 0.7;
          return (
            <g key={d.day} onMouseEnter={() => setHover(i)}>
              <rect x={i * bw} y={0} width={bw} height={H} fill="transparent" />
              <rect x={x} y={H - total} width={w} height={Math.max(0, total - bg)} rx={2} fill="var(--agent)" opacity={hover === null || hover === i ? 0.9 : 0.4} />
              <rect x={x} y={H - bg} width={w} height={bg} rx={2} fill="var(--accent)" opacity={hover === null || hover === i ? 0.9 : 0.4} />
            </g>
          );
        })}
        <line x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} stroke="var(--line)" />
      </svg>
    </div>
  );
}

function Legend({ cls, label }: { cls: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className={`size-2 rounded-sm ${cls}`} />
      {label}
    </span>
  );
}
