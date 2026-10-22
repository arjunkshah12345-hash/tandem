import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Settings } from "@shared";
import { api, type DeepPartial } from "../../api";
import { Input } from "../../components/ui";

interface SettingsCtx {
  settings: Settings;
  save: (patch: DeepPartial<Settings>) => Promise<void>;
  flash: (msg: string, error?: boolean) => void;
}

export const SettingsContext = createContext<SettingsCtx | null>(null);

export function useSettings() {
  const c = useContext(SettingsContext);
  if (!c) throw new Error("useSettings outside settings");
  return c;
}

export function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="animate-rise">
      <h2 className="font-display text-[22px] font-semibold tracking-tight">{title}</h2>
      {description ? <p className="mt-1 max-w-xl text-sm leading-relaxed text-muted">{description}</p> : null}
      <div className="mt-6 space-y-8">{children}</div>
    </section>
  );
}

export function Group({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-faint">{title}</h3>
        {action}
      </div>
      <div className="@container rounded-2xl border border-line bg-card px-4 py-2">{children}</div>
    </div>
  );
}

export function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-b border-line py-3 last:border-0 @lg:flex-row @lg:items-center @lg:justify-between @lg:gap-6">
      <div className="min-w-0">
        <div className="text-sm text-ink">{label}</div>
        {hint ? <div className="mt-0.5 text-[12.5px] text-muted">{hint}</div> : null}
      </div>
      <div className="min-w-0 shrink-0 @lg:max-w-[60%]">{children}</div>
    </div>
  );
}

/** Text input that commits on blur / Enter, so we don't PATCH on every keystroke. */
export function CommitInput({ value, onCommit, className, ...rest }: { value: string; onCommit: (v: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <Input
      {...rest}
      className={className}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onCommit(v)}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

export function errText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

export { api };
