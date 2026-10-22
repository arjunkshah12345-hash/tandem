import { useEffect, useState } from "react";

export function timeAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date(Date.now() - 86400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

export function usd(n: number): string {
  return n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`;
}

/** Tiny URL-state router: ?view=tasks&channel=main&task=… */
export function useQueryState() {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    window.addEventListener("popstate", f);
    window.addEventListener("tandem:nav", f);
    return () => {
      window.removeEventListener("popstate", f);
      window.removeEventListener("tandem:nav", f);
    };
  }, []);
  return new URLSearchParams(window.location.search);
}

export function navigate(params: Record<string, string | null>, replace = false) {
  const q = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(params)) {
    if (v === null) q.delete(k);
    else q.set(k, v);
  }
  const url = `${window.location.pathname}${q.toString() ? `?${q}` : ""}`;
  if (replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  window.dispatchEvent(new Event("tandem:nav"));
}

export function greeting(name: string): string {
  const h = new Date().getHours();
  const part = h < 5 ? "Up late" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  return name ? `${part}, ${name.split(" ")[0]}` : part;
}
