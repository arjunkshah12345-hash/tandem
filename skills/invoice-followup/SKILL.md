---
name: invoice-followup
description: Find overdue invoices and chase them politely with escalating tone; drafts go out only after approval.
---

# Invoice follow-up

## 1. Find what's overdue
- Accounting connector first (QuickBooks, Xero, Stripe invoices). Filter: status open/unpaid, due date before today.
- No accounting connector? Search email for sent invoices (`invoice`, `INV-`, attachments named invoice*) and cross-check for payment confirmations.
- Build a table: client, invoice #, amount, currency, due date, days overdue, last reminder sent (from memory or sent mail).

## 2. Pick the tone by days overdue
| Days late | Tone | Content |
|---|---|---|
| 1–7 | Friendly nudge | "Just a reminder… here's the link/PDF again." |
| 8–30 | Direct | Amount, original due date, ask for an expected payment date. |
| 31–60 | Firm | Reference previous reminders by date, mention any late-fee terms that exist in the contract — never invent terms. |
| 60+ | Stop and ask the user | Suggest a call or pausing work; do not draft escalation on your own. |

Skip clients the user has marked as "don't chase" in memory. Never threaten collections or legal action.

## 3. Draft
- One email per invoice, reply on the original invoice thread when it exists.
- Subject: `Invoice {number} — {amount} due {date}`.
- Include the payment link if the accounting system has one. Never type bank details yourself; if the user's invoices include them, attach the original invoice instead.
- Sign off as the user, in their voice (check memory for preferences).

## 4. Hand over
Save drafts (no approval needed), then present the batch as a table with one approval per send. Make an artifact (`csv`) of the overdue list so the user can sort it. After sending, save a memory: `Reminded {client} about {invoice} on {date}`.
