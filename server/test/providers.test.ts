import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { OpenAIAdapter } from "../src/providers/openai.ts";
import { GeminiAdapter } from "../src/providers/gemini.ts";

function mockServer(handler: (body: any, path: string) => string[]) {
  const seen: any[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ path: req.url, body, headers: req.headers });
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const chunk of handler(body, req.url ?? "")) res.write(`data: ${chunk}\n\n`);
      res.end();
    });
  });
  return new Promise<{ url: string; seen: any[]; close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => server.close() })),
  );
}

test("OpenAI-compatible adapter streams text and assembles split tool calls", async () => {
  const srv = await mockServer(() => [
    JSON.stringify({ model: "m", choices: [{ delta: { content: "Hel" } }] }),
    JSON.stringify({ choices: [{ delta: { content: "lo" } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "web_", arguments: '{"que' } }] } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "search", arguments: 'ry":"tandem"}' } }] }, finish_reason: "tool_calls" }] }),
    JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } }),
    "[DONE]",
  ]);
  try {
    const a = new OpenAIAdapter({ id: "groq", apiKey: "k", baseUrl: srv.url });
    let streamed = "";
    const r = await a.chat({
      model: "m",
      system: { stable: "sys", volatile: "now" },
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "tool_call", id: "t0", name: "x", args: { a: 1 } }] },
        { role: "user", content: [{ type: "tool_result", callId: "t0", name: "x", content: "ok" }] },
      ],
      tools: [{ name: "web_search", description: "d", parameters: { type: "object", properties: {} } }],
      onText: (d) => (streamed += d),
    });
    assert.equal(streamed, "Hello");
    assert.equal(r.stop, "tool_use");
    assert.deepEqual(r.content[1], { type: "tool_call", id: "call_1", name: "web_search", args: { query: "tandem" } });
    assert.deepEqual(r.usage, { inputTokens: 12, outputTokens: 5, costUsd: undefined, cacheReadTokens: 0 });
    const sent = srv.seen[0];
    assert.equal(sent.path, "/chat/completions");
    assert.equal(sent.headers.authorization, "Bearer k");
    assert.equal(sent.body.messages[0].role, "system");
    assert.equal(sent.body.messages[0].content, "sys\n\nnow");
    assert.equal(sent.body.messages[2].tool_calls[0].function.arguments, '{"a":1}');
    assert.deepEqual(sent.body.messages[3], { role: "tool", tool_call_id: "t0", content: "ok" });
    assert.equal(sent.body.max_tokens, 16000);
  } finally {
    srv.close();
  }
});

test("Gemini adapter maps function calls and preserves thought signatures", async () => {
  const srv = await mockServer(() => [
    JSON.stringify({ candidates: [{ content: { parts: [{ text: "Looking" }] } }] }),
    JSON.stringify({
      candidates: [{ content: { parts: [{ functionCall: { name: "web_search", args: { query: "x" } }, thoughtSignature: "sig123" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 7, thoughtsTokenCount: 3 },
    }),
  ]);
  try {
    const a = new GeminiAdapter({ apiKey: "g", baseUrl: srv.url });
    const r = await a.chat({ model: "gemini-x", system: { stable: "s" }, messages: [{ role: "user", content: [{ type: "text", text: "q" }] }], effort: "low" });
    assert.equal(r.stop, "tool_use");
    const tc = r.content[1] as any;
    assert.equal(tc.name, "web_search");
    assert.equal(tc.meta.thoughtSignature, "sig123");
    assert.deepEqual(r.usage, { inputTokens: 30, outputTokens: 10, cacheReadTokens: 0 });
    // Round-trip: the signature goes back on the functionCall part.
    await a.chat({
      model: "gemini-x",
      system: { stable: "s" },
      messages: [
        { role: "user", content: [{ type: "text", text: "q" }] },
        { role: "assistant", content: r.content },
        { role: "user", content: [{ type: "tool_result", callId: tc.id, name: "web_search", content: "results" }] },
      ],
    });
    const contents = srv.seen[1].body.contents;
    assert.equal(contents[1].role, "model");
    assert.equal(contents[1].parts[1].thoughtSignature, "sig123");
    assert.deepEqual(contents[2].parts[0].functionResponse, { name: "web_search", response: { result: "results" } });
    assert.match(srv.seen[0].path, /models\/gemini-x:streamGenerateContent\?alt=sse/);
  } finally {
    srv.close();
  }
});
