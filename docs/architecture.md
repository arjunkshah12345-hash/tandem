# Architecture

Tandem is a single Node process: a Hono HTTP server, an agent runtime, and a scheduler sharing one SQLite database (`node:sqlite`, WAL mode, FTS5). The web client is a React PWA that talks to `/api` over JSON and receives live updates over Server-Sent Events.

```
server/src
├── api/routes.ts        REST + SSE (/api/events), auth, OAuth callback
├── app.ts               wiring: config, db, vault, providers, tools, agent, scheduler
├── agent/
│   ├── agent.ts         chat turns per channel (queueing, streaming, stop)
│   ├── loop.ts          model ↔ tools loop, end states (done, ask_user, task_done, budget…)
│   ├── gate.ts          validate → hard limits → DLP → payment cap → approval → run → redact → fence
│   ├── approvals.ts     approval cards, decide/execute, feed results back
│   ├── tasks.ts         background task runner (concurrency 2, resumable)
│   ├── context.ts       history → model messages, compaction
│   ├── prompt.ts        stable (cached) + volatile system prompt
│   └── reviewer.ts      optional second-opinion model
├── providers/           anthropic.ts · openai.ts · gemini.ts · registry.ts (routing, fallbacks, cost)
├── tools/builtin/       core (memory, tasks, artifacts, routines, skills) · web · browser
├── connectors/          MCP (stdio, streamable HTTP, SSE; OAuth) · email (IMAP/SMTP) · calendar (ICS) · catalog
├── scheduler/           brief, check-ins, routines, quiet-hour flush, budgets, approval expiry
├── notify/              Web Push (VAPID), ntfy, webhook
├── channels/telegram.ts two-way chat + inline approval buttons
├── policy/              risk classification, sensitive-data scanner
├── vault/               AES-256-GCM secrets
└── store.ts, db.ts      persistence
```

## The agent loop

1. **Prompt.** It has two parts:
   - The **stable** part: persona, rules, safety policy and tool-use guidance. It is cache-friendly: with Anthropic it's marked with `cache_control`, alongside the last tool definition.
   - The **volatile** part: current time and timezone, profile, pinned and relevant memories, connected apps, skills, channels, the channel summary, open tasks and approvals, and the mode (chat, brief, check-in, routine or task).
2. **Stream.** The model's text deltas go to the UI over SSE, coalesced every 30ms.
3. **Tool calls.** Each one goes through the gate. Calls in one step run concurrently, and all results return to the model in one message.
4. **Reasoning.** Within a turn, history is append-only, so Anthropic thinking blocks and Gemini thought signatures are replayed exactly. Across turns, chat history is rebuilt as plain text.
5. **End states.**
   - `done`: the turn finished normally.
   - `ask_user` (tasks): the task needs an answer from you.
   - `task_done`: the agent suggests the task is complete; you confirm.
   - `max_steps`, `budget`: a limit was hit.
   - `stopped`: you pressed stop.
   - `refused`, `error`: the model declined or something failed.

## Proactivity

The scheduler ticks every 60 seconds and handles these jobs:
- **Morning brief.** Runs at the configured time, optionally weekdays only. If the machine was asleep, it can still run up to 3 hours late.
- **Check-ins.** Run every N hours inside the active window and outside quiet hours. Plain code prefetches unseen email and the next 4 hours of calendar. The *triage* model then answers `NOTIFY:` or `QUIET:`. Only `NOTIFY` posts a message and sends a notification.
- **Routines.** User-defined cron jobs, in your timezone. The agent can also create them from chat ("every Friday at 4…").
- **Housekeeping.**
  - Held notifications are flushed when quiet hours end.
  - Approvals expire after 7 days.
  - Background spend is checked against the daily cap.

## Tasks

A task is a durable job with its own transcript.

- **Running.** The runner executes up to 50 steps per run and up to 6 runs per task, two tasks at a time. A run pauses when it needs approval, asks a question, hits its budget, or suggests it's done.
- **Resuming.** Approval results, your replies and expirations resume the task with a note. Reasoning blocks from earlier runs are stripped.
- **Completion.** Only you can mark a task completed.

## Providers

All adapters convert between a neutral block format and the provider's wire format:

```
text | thinking (signature) | redacted_thinking | tool_use | tool_result
```

| Adapter | Implementation |
|---|---|
| **Anthropic** | Official SDK with streaming, adaptive thinking, `output_config.effort`, and eager tool-input streaming. Opus 5.5, Sonnet 5.5 and Fable 5.1 on the first-party API also get server-side fallbacks. |
| **OpenAI-compatible** | Chat Completions SSE: assembles split tool-call deltas, includes usage, and passes through OpenRouter's exact cost. |
| **Gemini** | Native `streamGenerateContent`; function calls carry their `thoughtSignature`. |

The registry applies the fallback chain with retries and records token usage and cost per call. Prices for known Claude models are built in; unknown models are priced conservatively, and local providers are free.

## Data

Everything lives in `~/.tandem/tandem.db`, except `vault.key` and your `skills/`. To back up, copy the directory, or use `sqlite3 tandem.db ".backup out.db"` while the server is running.
