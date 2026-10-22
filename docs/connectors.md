# Connecting apps

Tandem speaks the [Model Context Protocol](https://modelcontextprotocol.io). Any MCP server works, plus two built-ins that need no extra software: IMAP/SMTP email and ICS calendars.

## Email (IMAP/SMTP)

**Settings → Connected apps → Email.** Pick your provider, enter your address, and paste an *app password*.

| Provider | Where to get an app password |
|---|---|
| Gmail / Google Workspace | Google Account → Security → 2-Step Verification → App passwords |
| iCloud | appleid.apple.com → Sign-In and Security → App-Specific Passwords |
| Fastmail | Settings → Privacy & Security → App passwords |
| Outlook.com | account.microsoft.com → Security → Advanced security options → App passwords |

The connector exposes four tools:

| Tool | Risk | Approval |
|---|---|---|
| `email__search` | read | not needed |
| `email__read` | read | not needed |
| `email__save_draft` | internal | not needed |
| `email__send` | external | always required |

Check-ins watch for new mail.

## Calendar (ICS)

Paste a private iCal URL. For Google Calendar, go to Settings → *your calendar* → Integrate calendar → **Secret address in iCal format**. Access is read-only. Recurring events are expanded, and the calendar feeds the morning brief and meeting prep.

For read/write calendar access, use the Google Workspace connector below.

## Google Workspace (full)

Uses the open-source [workspace-mcp](https://github.com/taylorwilsdon/google_workspace_mcp) server via `uvx`. It covers Gmail, Calendar, Drive, Docs and Sheets, and needs a Google Cloud OAuth client (Desktop app). The Docker image ships with `uv`.

## Remote MCP servers with sign-in

Stripe, GitHub, Notion, Linear, Sentry and Atlassian each run an official remote MCP server. Add one from the catalog:

- **With a token** (Stripe restricted key, GitHub PAT): paste it. It's stored in the vault and sent as `Authorization: Bearer {{secret:…}}`.
- **Without a token**: the connector shows **Sign in**. You finish the provider's OAuth flow in a new tab. The callback lands on `TANDEM_PUBLIC_URL/api/connectors/oauth/callback`, so that URL must be reachable from your browser.

## Thousands more: Zapier and Composio

Both give you a single MCP URL that exposes the apps you enable on their side, such as QuickBooks, HubSpot, DocuSign, Salesforce and Shopify. Create the server on their dashboard and paste its URL. The URL contains a credential, so Tandem stores it as a secret.

## Anything else

- **Custom HTTP:** use the server URL plus optional headers.
- **Custom stdio:** use any command, e.g. `npx -y @modelcontextprotocol/server-filesystem ~/Documents`. Environment values can reference `{{secret:NAME}}`.

## Controlling what tools can do

Open a connector card to see every tool and its risk rating. You can:
- **Override the risk** of any tool. For example, mark a "create_record" tool as `read` if it only writes to a scratch table, or mark something as `forbidden`.
- **Hide a tool** so the agent never sees it.

Tool names reach the model as `<connector>__<tool>`. Changes apply immediately, with no restart.
