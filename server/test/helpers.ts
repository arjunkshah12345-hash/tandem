import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/app.ts";
import type { ChatRequest, ChatResponse, ProviderAdapter, Block } from "../src/providers/types.ts";
import type { Tool } from "../src/tools/types.ts";

export type Script = (req: ChatRequest, call: number) => Partial<ChatResponse> | Block[];

/** A model that follows a script — lets us test the whole agent without network calls. */
export class FakeModel implements ProviderAdapter {
  calls: ChatRequest[] = [];
  constructor(public script: Script) {}
  async listModels() {
    return ["scripted"];
  }
  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.calls.push(structuredClone({ ...req, signal: undefined, onText: undefined }));
    const r = this.script(req, this.calls.length - 1);
    const res: Partial<ChatResponse> = Array.isArray(r) ? { content: r } : r;
    const content = res.content ?? [];
    for (const b of content) if (b.type === "text") req.onText?.(b.text);
    return {
      content,
      stop: res.stop ?? (content.some((b) => b.type === "tool_call") ? "tool_use" : "end"),
      usage: res.usage ?? { inputTokens: 1000, outputTokens: 100 },
    };
  }
}

export function makeApp(script: Script, extraTools: Tool[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "tandem-test-"));
  const app = new App({ dataDir: dir, port: 0, host: "127.0.0.1", publicUrl: "http://localhost:0" });
  const model = new FakeModel(script);
  app.providers.save({ id: "fake", kind: "openai", label: "Fake", baseUrl: "http://fake", apiKeySecret: null, enabled: true });
  (app.providers as any).adapters.set("fake", model);
  app.settings.update({
    models: { work: "fake:work", triage: "fake:triage", fallbacks: [] },
    quietHours: { enabled: false, from: "21:00", to: "07:00" },
    browser: { enabled: false, headless: true, executablePath: null },
  });
  (app.providers as any).adapters.set("fake", model); // settings change invalidates adapters
  const base = app.tools.bind(app);
  app.tools = (o) => [...base(o), ...extraTools];
  const cleanup = async () => {
    await app.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  };
  return { app, model, cleanup };
}

export const text = (t: string): Block => ({ type: "text", text: t });
export const call = (name: string, args: Record<string, unknown>, id = `c_${name}_${Math.random().toString(36).slice(2, 7)}`): Block => ({
  type: "tool_call",
  id,
  name,
  args,
});

export async function until(cond: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A fake outbound tool that records calls. */
export function sendTool(sent: Record<string, unknown>[]): Tool {
  return {
    name: "mail__send_email",
    description: "Send an email",
    parameters: { type: "object", properties: { to: { type: "string" }, body: { type: "string" } }, required: ["to", "body"] },
    risk: "external",
    source: "mail",
    summarize: (a) => `Email to ${a.to}`,
    describe: (a) => ({ title: `Send email to ${a.to}`, preview: String(a.body) }),
    run: async (a) => {
      sent.push(a);
      return `sent to ${a.to}`;
    },
  };
}
