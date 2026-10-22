import type { RiskLevel } from "../shared.ts";

/**
 * Hard limits that no approval can override — mirrors Duet's "off-limits even with
 * consent" list, but enforced in code rather than by prompt.
 */
const FORBIDDEN: RegExp[] = [
  /(^|_)(buy|sell)_(stocks?|shares?|equit(y|ies)|options?|crypto|securit(y|ies)|bitcoin|btc|eth)(_|$)/,
  /(^|_)(create|place|submit|execute|make)_(trade|stock_order|crypto_order|market_order|limit_order)s?(_|$)/,
  /(^|_)(trade|trading)(_|$)/,
  /(^|_)(wire|transfer|move|send)_(money|funds|wire|balance)(_|$)/,
  /(^|_)(create_)?(transfer|payout|withdrawal|withdraw|bank_transfer|ach_transfer)s?(_|$)/,
];
const READ_PREFIX = /^(get|list|read|search|find|fetch|query|lookup|view|show|describe|retrieve|count|check)(_|$)/;

const RULES: { risk: RiskLevel; re: RegExp }[] = [
  { risk: "payment", re: /(^|_)(pay|payment|charge|purchase|checkout|buy|order|refund|subscribe|capture)(_|$)/ },
  { risk: "sign", re: /(^|_)(sign|signature|esign|countersign|accept_terms)(_|$)/ },
  { risk: "delete", re: /(^|_)(delete|remove|trash|destroy|purge|archive|drop|revoke|cancel|unsubscribe|close)(_|$)/ },
  {
    risk: "external",
    re: /(^|_)(send|reply|forward|post|publish|comment|message|email|tweet|share|invite|create|update|edit|write|set|add|put|patch|upload|book|schedule|assign|merge|move|rename|mark|label|react|dm|notify|submit|approve|transition|enable|disable)(_|$)/,
  },
];
const READ_RULE = /(^|_)(get|list|read|search|find|fetch|query|lookup|view|show|describe|retrieve|download|count|check|status|inspect)(_|$)/;

export interface ToolHints {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}

/** Classify a connector tool from its name, description and MCP annotations. */
export function classifyTool(name: string, description = "", hints: ToolHints = {}): RiskLevel {
  const n = splitName(name);
  if (!READ_PREFIX.test(n) && FORBIDDEN.some((r) => r.test(n))) return "forbidden";
  // A leading read verb wins: "get_payment_status" is a read.
  if (READ_PREFIX.test(n) && hints.destructiveHint !== true) return "read";
  for (const rule of RULES) {
    if (rule.re.test(n)) {
      // MCP read-only hints can downgrade name-based guesses like "check_status_update"
      if (hints.readOnlyHint === true && rule.risk === "external") return "read";
      if (rule.risk === "external" && hints.destructiveHint) return "delete";
      return rule.risk;
    }
  }
  if (hints.destructiveHint) return "delete";
  if (hints.readOnlyHint) return "read";
  if (READ_RULE.test(n)) return "read";
  // Unknown verbs: be conservative.
  return /\b(read|list|search|get|retrieve|returns?)\b/i.test(description.slice(0, 80)) ? "read" : "external";
}

/** Additional check on concrete arguments — e.g. a generic "http_request" tool doing a POST. */
export function forbiddenByArgs(name: string, args: Record<string, unknown>): string | null {
  const blob = `${splitName(name)} ${JSON.stringify(args).slice(0, 4000)}`;
  if (/\b(buy|sell)\b[^.]{0,40}\b(shares?|stocks?|options?|bitcoin|btc|eth|crypto)\b/i.test(blob)) {
    return "Trading securities or crypto is off-limits for Tandem, even with approval.";
  }
  if (/\b(wire|transfer|move)\b[^.]{0,30}(\b(money|funds)\b|\$\s?\d)/i.test(blob) && !/draft|memory|artifact|task/i.test(name)) {
    return "Moving money between accounts is off-limits for Tandem, even with approval.";
  }
  return null;
}

function splitName(name: string): string {
  return name
    .replace(/^[a-z0-9]+__/, "") // connector prefix
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase();
}

export const RISK_ORDER: RiskLevel[] = ["read", "internal", "external", "delete", "sign", "payment", "forbidden"];
