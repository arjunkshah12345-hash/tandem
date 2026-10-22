import { Ban, Play, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { RiskLevel, Routine } from "@shared";
import { Button, Field, IconButton, Input, Textarea, Toggle } from "../../components/ui";
import { timeAgo } from "../../util";
import { api, CommitInput, errText, Group, Row, Section, useSettings } from "./common";

export function ProfileSection() {
  const { settings: s, save } = useSettings();
  const [about, setAbout] = useState(s.about);
  const zones = (Intl as any).supportedValuesOf?.("timeZone") as string[] | undefined;
  return (
    <Section title="Profile" description="Tandem uses this to write like it knows you. Everything else it learns goes into Memory, where you can edit it.">
      <Group title="You">
        <Row label="Name">
          <CommitInput value={s.userName} onCommit={(v) => save({ userName: v })} className="@lg:w-64" />
        </Row>
        <Row label="Timezone" hint="Briefs, check-ins, quiet hours and routines follow this.">
          <CommitInput value={s.timezone} onCommit={(v) => save({ timezone: v })} list="tz-list" className="@lg:w-64" />
          {zones ? (
            <datalist id="tz-list">
              {zones.map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
          ) : null}
        </Row>
      </Group>
      <Field label="About your work" hint="Role, company, who matters, how you like things written. A few sentences is plenty.">
        <Textarea rows={6} value={about} onChange={(e) => setAbout(e.target.value)} onBlur={() => about !== s.about && save({ about })} />
      </Field>
    </Section>
  );
}

export function ScheduleSection() {
  const { settings: s, save, flash } = useSettings();
  return (
    <Section title="Schedule" description="When Tandem reaches out first. Background work counts against the daily budget below; it stops for the day once that's spent.">
      <Group
        title="Morning brief"
        action={
          <Button size="sm" variant="ghost" onClick={() => api.runBrief().then(() => flash("Brief started — check the thread"), (e) => flash(errText(e), true))}>
            <Play size={13} /> Run now
          </Button>
        }
      >
        <Toggle checked={s.brief.enabled} onChange={(v) => save({ brief: { enabled: v } })} label="Send a morning brief" hint="Calendar, inbox highlights, open tasks, and anything that needs a decision." />
        <Row label="Time">
          <Input type="time" value={s.brief.time} onChange={(e) => save({ brief: { time: e.target.value } })} className="w-32" />
        </Row>
        <Toggle checked={s.brief.weekdaysOnly} onChange={(v) => save({ brief: { weekdaysOnly: v } })} label="Weekdays only" />
      </Group>

      <Group
        title="Check-ins"
        action={
          <Button size="sm" variant="ghost" onClick={() => api.runCheckin().then(() => flash("Check-in started"), (e) => flash(errText(e), true))}>
            <Play size={13} /> Run now
          </Button>
        }
      >
        <Toggle
          checked={s.checkins.enabled}
          onChange={(v) => save({ checkins: { enabled: v } })}
          label="Check connected apps through the day"
          hint="A cheap triage model looks for anything new that's worth interrupting you for. Most check-ins stay quiet."
        />
        <Row label="Every">
          <select value={s.checkins.everyHours} onChange={(e) => save({ checkins: { everyHours: Number(e.target.value) } })} className="h-10 rounded-xl border border-line bg-card px-3 text-sm">
            {[1, 2, 3, 4, 6, 8].map((h) => (
              <option key={h} value={h}>
                {h} hour{h === 1 ? "" : "s"}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Between">
          <div className="flex items-center gap-2">
            <Input type="time" value={s.checkins.activeFrom} onChange={(e) => save({ checkins: { activeFrom: e.target.value } })} className="w-32" />
            <span className="text-faint">–</span>
            <Input type="time" value={s.checkins.activeTo} onChange={(e) => save({ checkins: { activeTo: e.target.value } })} className="w-32" />
          </div>
        </Row>
      </Group>

      <Group title="Quiet hours">
        <Toggle checked={s.quietHours.enabled} onChange={(v) => save({ quietHours: { enabled: v } })} label="Hold notifications overnight" hint="Non-urgent updates are bundled and delivered when quiet hours end." />
        <Row label="From">
          <div className="flex items-center gap-2">
            <Input type="time" value={s.quietHours.from} onChange={(e) => save({ quietHours: { from: e.target.value } })} className="w-32" />
            <span className="text-faint">–</span>
            <Input type="time" value={s.quietHours.to} onChange={(e) => save({ quietHours: { to: e.target.value } })} className="w-32" />
          </div>
        </Row>
      </Group>

      <Group title="Budget">
        <Row label="Background spend per day" hint="Briefs, check-ins and routines. 0 = no limit.">
          <DollarInput value={s.budget.dailyBackgroundUsd} onCommit={(v) => save({ budget: { dailyBackgroundUsd: v } })} />
        </Row>
        <Row label="Spend per task run" hint="A task pauses and asks before going over. 0 = no limit.">
          <DollarInput value={s.budget.perTaskUsd} onCommit={(v) => save({ budget: { perTaskUsd: v } })} />
        </Row>
      </Group>

      <Routines />
    </Section>
  );
}

function DollarInput({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  return (
    <div className="relative w-32">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-faint">$</span>
      <CommitInput type="number" min={0} step="0.5" value={String(value)} onCommit={(v) => onCommit(Math.max(0, Number(v) || 0))} className="pl-6" />
    </div>
  );
}

const CRON_PRESETS = [
  { label: "Every weekday 9am", cron: "0 9 * * 1-5" },
  { label: "Every Monday 8am", cron: "0 8 * * 1" },
  { label: "Every Friday 4pm", cron: "0 16 * * 5" },
  { label: "1st of the month 9am", cron: "0 9 1 * *" },
];

function Routines() {
  const { flash } = useSettings();
  const [list, setList] = useState<Routine[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: "", cron: "0 9 * * 1-5", prompt: "" });
  const load = () => api.routines().then(setList).catch((e) => flash(errText(e), true));
  useEffect(() => {
    void load();
  }, []);

  async function add() {
    try {
      await api.createRoutine(draft);
      setDraft({ name: "", cron: "0 9 * * 1-5", prompt: "" });
      setAdding(false);
      await load();
      flash("Routine scheduled");
    } catch (e) {
      flash(errText(e), true);
    }
  }

  return (
    <Group
      title="Routines"
      action={
        <Button size="sm" variant="ghost" onClick={() => setAdding((a) => !a)}>
          <Plus size={13} /> New
        </Button>
      }
    >
      {adding ? (
        <div className="space-y-3 border-b border-line py-3">
          <Input placeholder="Name, e.g. Weekly revenue recap" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <div className="flex flex-wrap gap-1.5">
            {CRON_PRESETS.map((p) => (
              <button key={p.cron} onClick={() => setDraft({ ...draft, cron: p.cron })} className={`h-7 rounded-full px-2.5 text-xs ${draft.cron === p.cron ? "bg-ink text-paper" : "bg-sunk text-muted"}`}>
                {p.label}
              </button>
            ))}
          </div>
          <Input placeholder="Cron (min hour day month weekday)" value={draft.cron} onChange={(e) => setDraft({ ...draft, cron: e.target.value })} className="font-mono" />
          <Textarea rows={3} placeholder="What should Tandem do?" value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" disabled={!draft.name || !draft.prompt} onClick={add}>
              Schedule
            </Button>
          </div>
        </div>
      ) : null}
      {list && list.length === 0 && !adding ? <p className="py-3 text-sm text-muted">No routines. You can also ask in the thread: &ldquo;every Friday at 4, recap my week&rdquo;.</p> : null}
      {list?.map((r) => (
        <div key={r.id} className="flex items-start gap-3 border-b border-line py-3 last:border-0">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{r.name}</div>
            <div className="mt-0.5 line-clamp-2 text-[13px] text-muted">{r.prompt}</div>
            <div className="mt-1 text-xs text-faint">
              <span className="font-mono">{r.cron}</span>
              {r.nextRunAt ? ` · next ${new Date(r.nextRunAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}` : ""}
              {r.lastRunAt ? ` · last ${timeAgo(r.lastRunAt)}` : ""}
            </div>
          </div>
          <div className="flex items-center gap-0.5">
            <IconButton label="Run now" onClick={() => api.runRoutine(r.id).then(() => flash("Running"), (e) => flash(errText(e), true))}>
              <Play size={15} />
            </IconButton>
            <IconButton
              label="Delete"
              onClick={async () => {
                await api.deleteRoutine(r.id);
                void load();
              }}
            >
              <Trash2 size={15} />
            </IconButton>
            <div className="-my-2 ml-1 w-11">
              <Toggle checked={r.enabled} onChange={(v) => api.updateRoutine(r.id, { enabled: v }).then(load)} label="" />
            </div>
          </div>
        </div>
      ))}
    </Group>
  );
}

const APPROVAL_RISKS: { risk: RiskLevel; label: string; hint: string }[] = [
  { risk: "external", label: "Sending & posting", hint: "Emails, messages, comments, calendar invites, form submissions." },
  { risk: "payment", label: "Payments & purchases", hint: "Anything that spends money." },
  { risk: "sign", label: "Signing & agreeing", hint: "Contracts, e-signatures, terms of service." },
  { risk: "delete", label: "Deleting", hint: "Removing files, records, messages or accounts." },
];

export function SafetySection() {
  const { settings: s, save } = useSettings();
  const required = new Set(s.safety.approvalRequired);
  return (
    <Section
      title="Safety"
      description="Tandem does the legwork on its own and stops at the door: anything that leaves on your behalf waits for your yes. If you're away, it finishes everything else and leaves the decision for you."
    >
      <Group title="Ask me before">
        {APPROVAL_RISKS.map((r) => (
          <Toggle
            key={r.risk}
            checked={required.has(r.risk)}
            onChange={(v) => {
              const next = new Set(required);
              if (v) next.add(r.risk);
              else if (!confirm(`Let Tandem do "${r.label.toLowerCase()}" without asking? This is not recommended.`)) return;
              else next.delete(r.risk);
              void save({ safety: { approvalRequired: [...next] } });
            }}
            label={r.label}
            hint={r.hint}
          />
        ))}
      </Group>

      <Group title="Guards">
        <Toggle
          checked={s.safety.blockSensitiveData}
          onChange={(v) => save({ safety: { blockSensitiveData: v } })}
          label="Block sensitive data from leaving"
          hint="Card numbers, government IDs, bank details, private keys and API tokens are stopped before they're sent anywhere."
        />
        <Toggle
          checked={s.safety.actionReviewer}
          onChange={(v) => save({ safety: { actionReviewer: v } })}
          label="Second opinion on risky actions"
          hint="A separate model reviews each approval for mistakes or signs of manipulation and flags concerns on the card."
        />
        <Row label="Largest single payment" hint="Payments above this are refused outright, even with approval.">
          <div className="relative w-32">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-faint">$</span>
            <CommitInput type="number" min={0} value={String(s.safety.maxPaymentUsd)} onCommit={(v) => save({ safety: { maxPaymentUsd: Math.max(0, Number(v) || 0) } })} className="pl-6" />
          </div>
        </Row>
      </Group>

      <Group title="Browser">
        <Toggle checked={s.browser.enabled} onChange={(v) => save({ browser: { enabled: v } })} label="Let Tandem use a browser" hint="For sites without an integration. You can watch and take over from Activity. Requires Chrome or Edge installed." />
        <Toggle checked={!s.browser.headless} onChange={(v) => save({ browser: { headless: !v } })} label="Show the browser window" hint="Useful on your own machine; leave off on a server." />
        <Row label="Browser path" hint="Optional. Leave blank to use installed Chrome or Edge.">
          <CommitInput value={s.browser.executablePath ?? ""} onCommit={(v) => save({ browser: { executablePath: v.trim() || null } })} placeholder="/usr/bin/chromium" className="font-mono text-[13px] @lg:w-72" />
        </Row>
      </Group>

      <div>
        <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.08em] text-faint">Never, even if you say yes</h3>
        <ul className="space-y-2 rounded-2xl border border-danger/25 bg-danger-soft/40 p-4 text-sm">
          {["Trading stocks, crypto or other securities", "Moving money between bank accounts or wiring funds", "Logging into or acting in someone else's account", "Typing passwords or card numbers into chat — use Secrets instead"].map((t) => (
            <li key={t} className="flex gap-2">
              <Ban size={15} className="mt-0.5 shrink-0 text-danger" />
              {t}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-faint">Content Tandem reads (emails, web pages, documents) is treated as information, never as instructions.</p>
      </div>
    </Section>
  );
}
