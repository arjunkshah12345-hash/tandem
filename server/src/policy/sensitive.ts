// Outbound data-loss prevention. Scans anything about to leave Tandem (emails, posts,
// form fills, HTTP bodies) for data that should never be sent without the user typing it
// themselves: payment card numbers, government IDs, bank details, credentials.

export interface Finding {
  kind: "card" | "ssn" | "iban" | "secret" | "private_key" | "routing";
  label: string;
  match: string;
}

const PATTERNS: { kind: Finding["kind"]; label: string; re: RegExp; check?: (m: string) => boolean }[] = [
  { kind: "card", label: "payment card number", re: /\b(?:\d[ -]?){13,19}\b/g, check: (m) => luhn(m.replace(/\D/g, "")) },
  {
    kind: "ssn",
    label: "US Social Security number",
    re: /\b(?!000|666|9\d\d)\d{3}[- ](?!00)\d{2}[- ](?!0000)\d{4}\b/g,
  },
  { kind: "iban", label: "IBAN bank account", re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/g, check: ibanOk },
  { kind: "private_key", label: "private key", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  {
    kind: "secret",
    label: "API key or token",
    re: /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{36}|gh[ousr]_[A-Za-z0-9]{36}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|sk_live_[0-9A-Za-z]{24,}|rk_live_[0-9A-Za-z]{24,})\b/g,
  },
  {
    kind: "routing",
    label: "bank routing + account number",
    re: /\brouting(?: number)?[:# ]*\d{9}\b[\s\S]{0,40}\baccount(?: number)?[:# ]*\d{6,17}\b/gi,
  },
];

export function scanSensitive(text: string): Finding[] {
  const out: Finding[] = [];
  for (const p of PATTERNS) {
    for (const m of text.matchAll(p.re)) {
      const s = m[0];
      if (p.check && !p.check(s)) continue;
      out.push({ kind: p.kind, label: p.label, match: s });
    }
  }
  return out;
}

export function redact(text: string, extraSecrets: string[] = []): string {
  let t = text;
  for (const s of extraSecrets) if (s && t.includes(s)) t = t.split(s).join("[secret]");
  for (const f of scanSensitive(t)) t = t.split(f.match).join(mask(f.match));
  return t;
}

function mask(s: string): string {
  const digits = s.replace(/\s/g, "");
  return digits.length > 8 ? `[redacted …${digits.slice(-4)}]` : "[redacted]";
}

export function luhn(num: string): boolean {
  if (num.length < 13 || num.length > 19 || /^(\d)\1+$/.test(num)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = num.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function ibanOk(raw: string): boolean {
  const s = raw.replace(/\s/g, "");
  if (s.length < 15 || s.length > 34) return false;
  const re = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of re) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}
