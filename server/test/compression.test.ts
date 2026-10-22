import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { call, makeApp, text, until } from "./helpers.ts";
import type { Tool } from "../src/tools/types.ts";

/** A stand-in for the hosted SuperCompress API: keeps lines mentioning "ERROR". */
async function fakeSupercompress(opts: { status?: number; risk?: string } = {}) {
  const seen: { key: string | undefined; body: { context: string; query: string } }[] = [];
  const server: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    seen.push({ key: req.headers["x-api-key"] as string | undefined, body });
    if (opts.status && opts.status !== 200) {
      res.writeHead(opts.status, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "nope" }));
    }
    const kept = body.context.split("\n").filter((l: string) => l.includes("ERROR"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        compressed_text: kept.join("\n"),
        original_tokens: Math.round(body.context.length / 4),
        kept_tokens: Math.round(kept.join("\n").length / 4),
        compression_risk: opts.risk ?? "low",
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.SUPERCOMPRESS_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/compress`;
  return {
    seen,
    close: () => {
      delete process.env.SUPERCOMPRESS_URL;
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}

const BIG_LOG = [...Array.from({ length: 400 }, (_, i) => `info: step ${i} ok — token=${i % 2 ? "hunter2-secret-value" : "fine"}`), "ERROR: disk full on /var/data"].join("\n");

const logTool: Tool = {
  name: "ops__read_logs",
  description: "Read server logs",
  parameters: { type: "object", properties: {}, required: [] },
  risk: "read",
  source: "ops",
  run: async () => ({ text: BIG_LOG, untrusted: true }),
};

function lastToolResult(model: { calls: any[] }, i: number) {
  return model.calls[i].messages.at(-1).content.find((b: any) => b.type === "tool_result").content as string;
}

test("large external results are compressed against the request; secrets never leave", async () => {
  const sc = await fakeSupercompress();
  const { app, model, cleanup } = makeApp((_r, n) => {
    if (n === 0) return [call("ops__read_logs", {}, "c_logs")];
    if (n === 1) return [call("get_full_result", { result_id: "res_c_logs" })];
    return [text("The disk is full.")];
  }, [logTool]);
  try {
    app.vault.set("SUPERCOMPRESS_API_KEY", "sc_live_test_key");
    app.vault.set("OPS_TOKEN", "hunter2-secret-value");
    app.settings.update({ compression: { enabled: true, minChars: 6000, scope: "all" } });
    (app.providers as any).adapters.set("fake", model); // settings changes reset adapters
    await app.agent.userMessage("main", "Why is the server down?");
    await until(() => !app.agent.isBusy("main") && model.calls.length === 3);

    // The API got the user's question, the key in a header, and redacted content only.
    assert.equal(sc.seen.length, 1);
    assert.equal(sc.seen[0].key, "sc_live_test_key");
    assert.match(sc.seen[0].body.query, /Why is the server down\?/);
    assert.ok(!sc.seen[0].body.context.includes("hunter2-secret-value"), "secret redacted before compression");

    // The model saw the compressed result, with the note outside the untrusted fence.
    const compressed = lastToolResult(model, 1);
    assert.match(compressed, /^\[SuperCompress kept the parts relevant/);
    assert.match(compressed, /<untrusted_content source="ops__read_logs">\nERROR: disk full on \/var\/data\n<\/untrusted_content>/);
    assert.ok(compressed.length < 600);

    // get_full_result returns the original (still redacted, still fenced).
    const full = lastToolResult(model, 2);
    assert.match(full, /info: step 399 ok/);
    assert.ok(!full.includes("hunter2-secret-value"));
    assert.match(full, /^<untrusted_content/);

    const st = app.compressor.status();
    assert.equal(st.today.calls, 1);
    assert.ok(st.today.keptTokens < st.today.originalTokens);
  } finally {
    await cleanup();
    await sc.close();
  }
});

test("compression fails open: no key, small output, bad key, high risk", async () => {
  // No key configured → no call, and no get_full_result tool offered.
  const sc = await fakeSupercompress();
  const a = makeApp((_r, n) => (n === 0 ? [call("ops__read_logs", {})] : [text("ok")]), [logTool]);
  try {
    await a.app.agent.userMessage("main", "check logs");
    await until(() => !a.app.agent.isBusy("main") && a.model.calls.length === 2);
    assert.equal(sc.seen.length, 0);
    assert.match(lastToolResult(a.model, 1), /info: step 0 ok/);
    assert.ok(!(a.model.calls[0].tools ?? []).some((t: any) => t.name === "get_full_result"));
  } finally {
    await a.cleanup();
    await sc.close();
  }

  // 401 → original result, compression pauses, activity log explains why.
  const bad = await fakeSupercompress({ status: 401 });
  const b = makeApp((_r, n) => (n === 0 ? [call("ops__read_logs", {})] : n === 1 ? [call("ops__read_logs", {})] : [text("ok")]), [logTool]);
  try {
    b.app.vault.set("SUPERCOMPRESS_API_KEY", "sc_live_wrong");
    b.app.settings.update({ compression: { enabled: true, minChars: 6000, scope: "all" } });
    (b.app.providers as any).adapters.set("fake", b.model); // settings changes reset adapters
    await b.app.agent.userMessage("main", "check logs");
    await until(() => !b.app.agent.isBusy("main") && b.model.calls.length === 3);
    assert.match(lastToolResult(b.model, 1), /info: step 0 ok/);
    assert.equal(bad.seen.length, 1, "paused after the 401 — second result not sent");
    assert.match(b.app.compressor.status().paused ?? "", /rejected the API key/);
    assert.ok(b.app.store.listActivity(20).some((e) => e.summary === "Context compression paused"));
  } finally {
    await b.cleanup();
    await bad.close();
  }

  // High-risk verdict → original kept.
  const risky = await fakeSupercompress({ risk: "high" });
  const c = makeApp((_r, n) => (n === 0 ? [call("ops__read_logs", {})] : [text("ok")]), [logTool]);
  try {
    c.app.vault.set("SUPERCOMPRESS_API_KEY", "sc_live_test_key");
    c.app.settings.update({ compression: { enabled: true, minChars: 6000, scope: "all" } });
    (c.app.providers as any).adapters.set("fake", c.model); // settings changes reset adapters
    await c.app.agent.userMessage("main", "check logs");
    await until(() => !c.app.agent.isBusy("main") && c.model.calls.length === 2);
    assert.equal(risky.seen.length, 1);
    assert.match(lastToolResult(c.model, 1), /info: step 0 ok/);
  } finally {
    await c.cleanup();
    await risky.close();
  }
});

test("default scope skips live chat but compresses background tasks", async () => {
  const sc = await fakeSupercompress();
  const { app, model, cleanup } = makeApp((req) => {
    const sawLogs = req.messages.some((m) => m.content.some((b) => b.type === "tool_result" && b.name === "ops__read_logs"));
    if (req.system.volatile?.includes("running a background task")) return sawLogs ? [call("task_done", { summary: "Disk is full." })] : [call("ops__read_logs", {})];
    return sawLogs ? [text("ok")] : [call("ops__read_logs", {})];
  }, [logTool]);
  try {
    app.vault.set("SUPERCOMPRESS_API_KEY", "sc_live_test_key");
    await app.agent.userMessage("main", "check logs");
    await until(() => !app.agent.isBusy("main") && model.calls.length === 2);
    assert.equal(sc.seen.length, 0, "live chat not compressed by default");

    const t = app.store.createTask({ channelId: "main", title: "Investigate outage", brief: "Find out why the server is down" });
    app.tasks.enqueue(t.id);
    await until(() => app.store.getTask(t.id)?.status === "suggested_done", 5000);
    assert.equal(sc.seen.length, 1, "task results are compressed");
    assert.match(sc.seen[0].body.query, /Investigate outage/);
  } finally {
    await cleanup();
    await sc.close();
  }
});
