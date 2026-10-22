import clsx from "clsx";
import { X } from "lucide-react";
import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes, forwardRef } from "react";
import type { RiskLevel } from "@shared";

type Variant = "primary" | "accent" | "ghost" | "quiet" | "danger";

export function Button({
  variant = "quiet",
  size = "md",
  className,
  busy,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md"; busy?: boolean }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || busy}
      className={clsx(
        "inline-flex items-center justify-center gap-1.5 rounded-full font-medium transition-[background,color,transform,opacity] active:scale-[0.97] disabled:opacity-45 disabled:active:scale-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-agent cursor-pointer disabled:cursor-default select-none",
        size === "sm" ? "h-8 px-3 text-[13px]" : "h-10 px-4 text-sm",
        variant === "primary" && "bg-ink text-paper hover:opacity-90",
        variant === "accent" && "bg-accent text-white hover:brightness-105",
        variant === "quiet" && "bg-sunk text-ink hover:bg-line",
        variant === "ghost" && "text-muted hover:text-ink hover:bg-sunk",
        variant === "danger" && "bg-danger-soft text-danger hover:brightness-95",
        className,
      )}
    >
      {busy ? <Spinner /> : null}
      {children}
    </button>
  );
}

export function IconButton({ label, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      className={clsx(
        "inline-grid size-9 place-items-center rounded-full text-muted transition hover:bg-sunk hover:text-ink active:scale-95 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-agent cursor-pointer",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span className={clsx("inline-block size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent", className)} aria-hidden />;
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return (
    <input
      ref={ref}
      {...rest}
      className={clsx(
        "h-10 w-full rounded-xl border border-line bg-card px-3 text-sm text-ink placeholder:text-faint outline-none transition focus:border-agent focus:ring-2 focus:ring-agent/15",
        className,
      )}
    />
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      {...rest}
      className={clsx(
        "w-full rounded-xl border border-line bg-card px-3 py-2.5 text-sm text-ink placeholder:text-faint outline-none transition focus:border-agent focus:ring-2 focus:ring-agent/15",
        className,
      )}
    />
  );
});

export function Select({ value, onChange, options, className }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; className?: string }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={clsx("h-10 w-full rounded-xl border border-line bg-card px-3 text-sm text-ink outline-none focus:border-agent", className)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-2">
      <span>
        <span className="block text-sm text-ink">{label}</span>
        {hint ? <span className="mt-0.5 block text-[13px] text-muted">{hint}</span> : null}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={clsx("relative mt-0.5 h-6 w-10 shrink-0 rounded-full transition", checked ? "bg-agent" : "bg-line")}
      >
        <span className={clsx("absolute top-0.5 size-5 rounded-full bg-card shadow transition-[left]", checked ? "left-[18px]" : "left-0.5")} />
      </button>
    </label>
  );
}

export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-[13px] font-medium text-muted">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-faint">{hint}</span> : null}
    </label>
  );
}

const RISK_STYLE: Record<RiskLevel, { label: string; cls: string }> = {
  read: { label: "Read", cls: "bg-sunk text-muted" },
  internal: { label: "Internal", cls: "bg-sunk text-muted" },
  external: { label: "Sends", cls: "bg-agent-soft text-agent" },
  payment: { label: "Payment", cls: "bg-accent-soft text-accent" },
  sign: { label: "Signature", cls: "bg-accent-soft text-accent" },
  delete: { label: "Deletes", cls: "bg-danger-soft text-danger" },
  forbidden: { label: "Off-limits", cls: "bg-danger-soft text-danger" },
};

export function RiskBadge({ risk }: { risk: RiskLevel }) {
  const r = RISK_STYLE[risk];
  return <span className={clsx("rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide", r.cls)}>{r.label}</span>;
}

export function Pill({ children, tone = "muted", className }: { children: ReactNode; tone?: "muted" | "agent" | "accent" | "danger" | "ok"; className?: string }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        tone === "muted" && "bg-sunk text-muted",
        tone === "agent" && "bg-agent-soft text-agent",
        tone === "accent" && "bg-accent-soft text-accent",
        tone === "danger" && "bg-danger-soft text-danger",
        tone === "ok" && "bg-agent-soft text-ok",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Right-side drawer on desktop, bottom sheet on mobile. */
export function Sheet({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-end md:items-stretch" role="dialog" aria-modal>
      <button className="absolute inset-0 bg-ink/25 backdrop-blur-[2px]" aria-label="Close" onClick={onClose} />
      <div
        className={clsx(
          "animate-rise relative flex max-h-[92dvh] w-full flex-col rounded-t-3xl border border-line bg-paper shadow-2xl md:max-h-none md:rounded-none md:rounded-l-3xl",
          wide ? "md:w-[min(920px,92vw)]" : "md:w-[480px]",
        )}
      >
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <div className="min-w-0 truncate font-display text-lg font-semibold">{title}</div>
          <IconButton label="Close" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center px-6 py-16 text-center">
      <div className="mb-4 grid size-12 place-items-center rounded-2xl bg-sunk text-muted">{icon}</div>
      <div className="font-display text-lg font-semibold">{title}</div>
      {children ? <div className="mt-1.5 text-sm text-muted">{children}</div> : null}
    </div>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <h3 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-faint">{children}</h3>
      {action}
    </div>
  );
}
