---
name: research-report
description: Run a structured web research job and deliver a sourced report or comparison table as an artifact.
---

# Research report

1. **Frame it.** Restate the question in one sentence and list 3–6 sub-questions. If scope is ambiguous and the job is large, ask one clarifying question first (as a task, use `task_ask_user`).
2. **Search wide, then deep.** Several `web_search` queries with different phrasings; `web_fetch` the primary sources (official sites, docs, pricing pages, filings) rather than summaries of them.
3. **Track sources.** Every claim gets a link. Note the date of anything time-sensitive (prices, headcounts, versions).
4. **Compare.** For "X vs Y" questions, build a `csv` artifact with one row per option and consistent columns; for narrative questions, a `markdown` artifact.
5. **Conclude.** End with a short recommendation and the 2–3 facts it rests on, plus what you couldn't verify.

Quality bar: no unsourced numbers, no padding, flag conflicting sources instead of picking one silently.
