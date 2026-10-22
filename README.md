<p align="center"><img src="web/public/icon.svg" width="72" alt="" /></p>

<h1 align="center">Tandem</h1>

<p align="center"><b>An open-source, self-hosted, proactive AI assistant. Works with any model.</b><br/>
It messages you first, keeps working while you're away, and asks before anything leaves the building.</p>

---

Tandem is an open alternative to [Claude Duet](https://claude.com/product/claude-duet), Anthropic's proactive agent research preview (Oct 2026). It runs on your laptop, a home server or a $5 VPS. You pick the models (Claude, GPT, Gemini, open-weight models via OpenRouter/Groq/Together, or fully local with Ollama), and every byte of your data stays in one SQLite file you own.

- **It reaches out first.** You get a morning brief, check-ins every few hours that stay quiet unless something matters, and scheduled routines in plain cron.
- **One thread, plus channels.** Talk in one place. Topic channels share the same memory. You can type or dictate.
- **Tasks that run in the background.** Hand off longer jobs. Tandem works through them, asks when it's stuck, and suggests when it's done. Only you can mark a task complete.
- **Make tab.** Dashboards, docs, tables and prototypes appear as editable artifacts. HTML runs in a locked-down sandbox.
- **It asks before it acts.** Sending, paying, signing and deleting all wait for your approval. While a request waits, Tandem finishes the rest of the job. You can approve from the web, a phone notification or Telegram, and you can edit the payload first.
- **Some things are off-limits, even with approval:**
  - Trading securities
  - Moving money between accounts
  - Acting in someone else's account
- **Connects to anything that speaks MCP.** There are one-click templates for Gmail/IMAP, calendars, Google Workspace, Stripe, GitHub, Notion, Linear, Sentry, Atlassian, Zapier and Composio. Zapier and Composio each add thousands of apps.
- **A real browser.** You can watch it live and take over for logins and CAPTCHAs. Saved passwords are filled without the model ever seeing them.

## Tandem vs. Claude Duet

| | Claude Duet (research preview) | Tandem |
|---|---|---|
| Models | Claude Opus 5.5 only | Any: Anthropic, OpenAI, Gemini, OpenRouter, xAI, Mistral, DeepSeek, Groq, Together, Fireworks, Cerebras, Moonshot, Azure, Ollama, LM Studio, any OpenAI-compatible URL |
| Model routing | Fixed | Separate work and triage models, plus a fallback chain |
| Hosting | Anthropic cloud VM | Your machine or server; one SQLite file |
| Morning brief, check-ins, routines | ✓ | ✓ (cron routines, quiet hours, daily background budget) |
| Main thread + topic channels with shared memory | ✓ | ✓ |
| Tasks tab, user-only completion | ✓ | ✓ |
| Make tab (artifacts) | ✓ | ✓ HTML/Markdown/CSV/JSON, versioned, editable, sandboxed |
| Approve before send/pay/sign/delete | ✓ | ✓ Approvals can be edited first, and an optional second model reviews each one |
| Hard limits even with consent | ✓ | ✓ |
| Sensitive-data blocking | ✓ | ✓ Covers card numbers (Luhn), SSNs, IBANs, routing numbers, private keys and API tokens |
| Prompt-injection handling | Content treated as data | Tool output fenced as untrusted; secrets scrubbed from everything the model reads |
| Watch / take over the browser | ✗ | ✓ Live frames and click-through takeover |
| Choose your model | ✗ | ✓ |
| Connectors | 6,000+ managed | Any MCP server (stdio or HTTP with OAuth), built-in IMAP/SMTP and ICS, Zapier/Composio |
| Notifications | App | Web Push (PWA, iOS-compatible), Telegram with approve buttons, ntfy, webhooks |
| Spend controls | Plan usage | Per-day background cap and per-task cap; per-model cost view |
| Skills | — | Anthropic-style `SKILL.md` folders, loaded on demand |
| Price | Paid plan | Free (Apache-2.0); you pay your model provider |

## Quick start

Requires **Node 22.13+** (uses the built-in `node:sqlite`).

```bash
git clone <this repo> tandem && cd tandem
npm install
npm run build
npm start            # → http://localhost:7420
```

Open the URL, choose a password, then go to **Settings → Models** and paste a key. Anthropic, OpenAI, Gemini and OpenRouter all work, or you can point Tandem at Ollama. After that, connect email and calendar under **Settings → Connected apps**.

**Try it without a key.** A scripted mock model ships with the repo:
```bash
node scripts/mock-llm.mjs   # then add a Custom OpenAI-compatible provider at http://localhost:11999/v1, model "custom:mock"
```

### Docker

```bash
cp .env.example .env        # optional: provider keys, TANDEM_PUBLIC_URL
docker compose up -d        # → http://localhost:7420
```

The image includes Chromium (for the browser tool) and `uv` (for Python MCP servers). Data lives in the `tandem-data` volume.

### On your phone

Put Tandem behind HTTPS with Tailscale Serve, a Cloudflare Tunnel or Caddy, and set `TANDEM_PUBLIC_URL`. Then open it on your phone and use **Add to Home Screen**. It installs as a PWA with push notifications, which also work on iOS. If you'd rather use chat, connect a Telegram bot in **Settings → Notifications**. You can talk to Tandem and approve actions from there.

### CLI

```bash
npx tandem doctor                 # check node, models, connectors, browser
npx tandem reset-password         # prompts; signs out every session
npx tandem secret NAME            # store a secret (hidden prompt, or pipe it on stdin)
```

## How it works

```
 web (React PWA) ─┐                       ┌─ Anthropic / OpenAI-compatible / Gemini adapters
 Telegram ────────┼── Hono API + SSE ── Agent loop ── Tool gate ── built-in tools (memory, tasks, artifacts, web, browser…)
 Web Push/ntfy ◀──┘        │             │            │          └─ MCP connectors (stdio/HTTP+OAuth), IMAP/SMTP, ICS
                           │        Task runner   Approvals ─ notify ─▶ you
                      Scheduler (brief · check-ins · routines · quiet hours · budgets)
                           │
                     SQLite (FTS5 memory & chat search, encrypted vault)
```

- **Agent loop.** The loop streams the reply and runs tools in parallel. Each step's results go back to the model in a single turn. Reasoning blocks from Claude and Gemini are carried through the turn so long tool chains stay coherent.
- **Tool gate.** Every tool call passes through these checks in order:
  1. Schema validation
  2. Hard limits
  3. Sensitive-data scan
  4. Payment cap
  5. Approval (non-blocking: the agent keeps working on everything else)
  6. Execution
  7. Secret redaction on the output
  8. An untrusted-content fence around the output
- **Risk levels.** Every tool is rated `read`, `internal`, `external`, `payment`, `sign`, `delete` or `forbidden`. Ratings come from the tool's annotations and name, and you can override them per tool. Browser clicks are rated by the label of the element being clicked: "Pay now" counts as a payment and "Send" counts as external.
- **Proactivity on a budget.** Check-ins prefetch new mail and upcoming events in plain code. A cheap triage model then decides `NOTIFY` or `QUIET`, so most check-ins cost a fraction of a cent. Background work stops for the day once it hits your cap.
- **Memory.** Durable facts live in SQLite with FTS5. Pinned memories are always in context, and relevant ones are recalled per message. Long channels are summarized automatically.

See [docs/architecture.md](docs/architecture.md), [docs/security.md](docs/security.md) and [docs/connectors.md](docs/connectors.md).

## Supported providers

| Provider | Protocol | Notes |
|---|---|---|
| Anthropic | Messages API (official SDK) | Adaptive thinking, prompt caching, server-side fallbacks for Opus 5.5 / Sonnet 5.5 / Fable 5.1 |
| OpenAI, Azure OpenAI | Chat Completions | |
| Google Gemini | Native `generateContent` | Thought signatures preserved across tool calls |
| OpenRouter, xAI, Mistral, DeepSeek, Groq, Together, Fireworks, Cerebras, Moonshot | OpenAI-compatible | OpenRouter reports exact cost |
| Ollama, LM Studio, vLLM, llama.cpp, any compatible URL | OpenAI-compatible | Local models are free and private |

Default routing is `anthropic:claude-opus-5-5` for work and `anthropic:claude-haiku-5-5` for triage. Change either one in **Settings → Models**.

## Configuration

| Env | Default | |
|---|---|---|
| `TANDEM_PORT` | `7420` | |
| `TANDEM_HOST` | `127.0.0.1` | Use `0.0.0.0` only behind a proxy or in Docker |
| `TANDEM_DATA_DIR` | `~/.tandem` | Database, vault key, your skills |
| `TANDEM_PUBLIC_URL` | `http://localhost:PORT` | Used for links, OAuth callbacks and Secure cookies |
| `TANDEM_SECRET_KEY` | random per install | Vault encryption passphrase |
| `TANDEM_BROWSER_PATH` | auto (Chrome/Edge) | Chromium executable |
| `TANDEM_ALLOW_PRIVATE_FETCH` | off | Let web tools reach LAN addresses |
| `ANTHROPIC_API_KEY` etc. | | Provider keys can come from the environment |

## Development

```bash
npm run dev      # API on :7420 (tsx watch) + Vite on :5173 with proxy
npm test         # server test suite (node:test)
npm run typecheck
```

The layout is `server/` for the API, agent, tools, connectors and scheduler, `web/` for the React 19, Vite and Tailwind 4 PWA, and `skills/` for the bundled `SKILL.md` playbooks.

## Status

This is an early release. The approval flow, the hard limits and the vault have tests. Still, treat Tandem like a new assistant: start it on read-only connectors and keep approvals on for anything that leaves your machine.

## License

Apache-2.0. Not affiliated with Anthropic. "Claude" and "Claude Duet" are trademarks of Anthropic, PBC.
