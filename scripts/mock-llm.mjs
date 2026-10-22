#!/usr/bin/env node
// A scripted OpenAI-compatible model for trying the Tandem UI without an API key.
//
//   node scripts/mock-llm.mjs            # listens on :11999
//   Settings → Models → Custom OpenAI-compatible: base URL http://localhost:11999/v1, enable
//   Work + triage model: custom:mock
//
// Say "dashboard" to get an artifact, "post" to trigger an approval card, "task" to start a
// background task; anything else gets a streamed markdown reply.
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 11999);

const DASHBOARD = `<!doctype html><html><head><meta charset="utf-8"><style>
body{font:15px system-ui;margin:0;padding:28px;background:#faf8f4;color:#1f1d1a}
h1{font:600 22px Georgia,serif;margin:0 0 18px}.g{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.c{background:#fff;border:1px solid #e3dbcd;border-radius:14px;padding:14px}.v{font:600 26px Georgia,serif}
.l{color:#6f695f;font-size:12px}.bar{display:flex;align-items:flex-end;gap:6px;height:120px;margin-top:18px}
.bar div{flex:1;background:#2f5d50;border-radius:4px 4px 0 0}</style></head><body>
<h1>October revenue</h1><div class="g"><div class="c"><div class="l">MRR</div><div class="v">$48.2k</div></div>
<div class="c"><div class="l">New customers</div><div class="v">37</div></div><div class="c"><div class="l">Churn</div><div class="v">1.8%</div></div></div>
<div class="bar">${[42, 55, 48, 61, 70, 66, 82, 77, 90, 96]
  .map((h) => `<div style="height:${h}%"></div>`)
  .join("")}</div></body></html>`;

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const text = typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => p.text ?? "").join("\n");
    // Ignore system notes that were folded into the same user turn.
    return text.replace(/<system_note[^>]*>[\s\S]*?<\/system_note>/g, "").trim();
  }
  return "";
}

function plan(body) {
  const msgs = body.messages ?? [];
  const last = msgs[msgs.length - 1];
  const sys = msgs.find((m) => m.role === "system");
  const sysText = typeof sys?.content === "string" ? sys.content : "";
  // Triage / summarise calls: keep it quiet.
  if (!body.tools?.length) {
    if (/NOTIFY:|QUIET:/.test(sysText + JSON.stringify(msgs).slice(-4000))) return { text: "QUIET: nothing new worth interrupting for." };
    if (/"ok"/.test(sysText)) return { text: '{"ok": true, "concern": null}' };
    return { text: "Summary: earlier conversation about getting set up." };
  }
  if (last?.role === "tool") {
    const name = msgs.findLast((m) => m.tool_calls)?.tool_calls?.[0]?.function?.name;
    if (name === "create_artifact") return { text: "Done — **October revenue** is on the Make tab. MRR is up 9% month over month; want me to add a churn breakdown?" };
    if (name === "http_request") return { text: "Queued that for your approval. I'll carry on once you decide." };
    if (name === "start_task") return { text: "Started it as a background task — I'll ping you when there's something to look at." };
    if (name === "task_done") return { text: "Wrapped up." };
    return { text: "Done." };
  }
  const u = lastUserText(msgs).toLowerCase();
  const inTask = /You are working on a background task/i.test(sysText) || /task_done/.test(JSON.stringify(body.tools.map((t) => t.function.name)));
  if (inTask && body.tools.some((t) => t.function.name === "task_done") && !/task_done/.test(JSON.stringify(msgs.slice(-3))))
    return { tool: { name: "task_done", args: { summary: "Compared Linear, Height and Plane on price, integrations and AI features. Linear leads on polish; Plane is the open-source pick." } } };
  if (u.includes("task")) return { tool: { name: "start_task", args: { title: "Compare project tools", brief: "Compare Linear, Height and Plane on price, integrations, and AI features. Make a table." } } };
  if (u.includes("dashboard")) return { tool: { name: "create_artifact", args: { title: "October revenue", kind: "html", content: DASHBOARD } } };
  if (u.includes("post"))
    return { tool: { name: "http_request", args: { method: "POST", url: "https://example.com/hooks/standup", headers: { "content-type": "application/json" }, body: '{"text":"Standup: shipped the onboarding flow, starting billing next."}' } } };
  return {
    text: "Here's how I can help:\n\n- **Keep watch** — I check your inbox and calendar every few hours and only speak up when something matters.\n- **Do the legwork** — research, drafts, spreadsheets, dashboards. Longer jobs run as *tasks* in the background.\n- **Ask first** — anything that sends, pays, signs or deletes waits for your approval.\n\nTry: *make me a revenue dashboard*, *post the standup*, or *start a task to compare project tools*.",
  };
}

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url?.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ data: [{ id: "mock" }] }));
  }
  let raw = "";
  for await (const c of req) raw += c;
  const body = JSON.parse(raw || "{}");
  const p = plan(body);
  res.writeHead(200, { "content-type": "text/event-stream" });
  const base = { id: "mock", object: "chat.completion.chunk", model: "mock" };
  if (p.tool) {
    sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: { name: p.tool.name, arguments: JSON.stringify(p.tool.args) } }] } }] });
    sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  } else {
    for (const word of p.text.match(/\S+\s*/g) ?? []) {
      sse(res, { ...base, choices: [{ index: 0, delta: { content: word } }] });
      await new Promise((r) => setTimeout(r, 18));
    }
    sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  }
  sse(res, { ...base, choices: [], usage: { prompt_tokens: 1200, completion_tokens: 140 } });
  res.end("data: [DONE]\n\n");
});

server.listen(PORT, () => console.log(`mock LLM on http://localhost:${PORT}/v1 (model id: mock)`));
