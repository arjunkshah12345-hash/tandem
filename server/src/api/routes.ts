import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { Cron } from "croner";
import type { App } from "../app.ts";
import type { ConnectorConfig, ProviderConfig, Settings, UsageSummary } from "../shared.ts";
import { bus } from "../bus.ts";
import { PROVIDER_PRESETS, parseModelRef } from "../providers/registry.ts";
import { CATALOG } from "../connectors/catalog.ts";
import { errorMessage, zonedParts } from "../util.ts";

const SESSION_COOKIE = "tandem_session";
const SESSION_DAYS = 30;

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  return `${salt.toString("hex")}:${scryptSync(pw, salt, 64).toString("hex")}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const a = scryptSync(pw, Buffer.from(salt, "hex"), 64);
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createApi(app: App) {
  const api = new Hono();
  const failures = new Map<string, { n: number; until: number }>();

  const authed = (c: Context): boolean => {
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) return false;
    const row = app.db.prepare("SELECT expires_at FROM sessions WHERE token = ?").get(token) as { expires_at: number } | undefined;
    return !!row && row.expires_at > Date.now();
  };
  const setupRequired = () => !app.kv.get<string | null>("password_hash", null);
  const newSession = (c: Context) => {
    const token = randomBytes(32).toString("base64url");
    app.db.prepare("INSERT INTO sessions (token, created_at, expires_at) VALUES (?,?,?)").run(token, Date.now(), Date.now() + SESSION_DAYS * 86400_000);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "Strict",
      secure: app.config.publicUrl.startsWith("https"),
      path: "/",
      maxAge: SESSION_DAYS * 86400,
    });
  };

  api.onError((err, c) => {
    const msg = errorMessage(err);
    const status = /not found/i.test(msg) ? 404 : 400;
    return c.json({ error: msg }, status);
  });

  // ---------------- auth ----------------
  api.get("/me", (c) => c.json({ authed: authed(c), setupRequired: setupRequired(), userName: app.settings.get().userName }));

  api.post("/setup", async (c) => {
    if (!setupRequired()) return c.json({ error: "Already set up" }, 409);
    const b = await c.req.json<{ password: string; userName?: string; timezone?: string; about?: string }>();
    if (!b.password || b.password.length < 8) return c.json({ error: "Password must be at least 8 characters" }, 400);
    app.kv.set("password_hash", hashPassword(b.password));
    app.settings.update({ userName: b.userName ?? "", ...(b.timezone ? { timezone: b.timezone } : {}), ...(b.about ? { about: b.about } : {}) });
    newSession(c);
    return c.json({ ok: true });
  });

  api.post("/login", async (c) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    const f = failures.get(ip);
    if (f && f.until > Date.now()) return c.json({ error: "Too many attempts. Try again in a minute." }, 429);
    const { password } = await c.req.json<{ password: string }>();
    const hash = app.kv.get<string | null>("password_hash", null);
    if (!hash || !verifyPassword(String(password ?? ""), hash)) {
      const n = (f?.n ?? 0) + 1;
      failures.set(ip, { n, until: n >= 5 ? Date.now() + 60_000 : 0 });
      return c.json({ error: "Wrong password" }, 401);
    }
    failures.delete(ip);
    newSession(c);
    return c.json({ ok: true });
  });

  api.post("/logout", (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) app.db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  // OAuth callback for MCP connectors arrives via a top-level browser redirect.
  api.get("/connectors/oauth/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return c.html(page("Sign-in failed", c.req.query("error_description") ?? c.req.query("error") ?? "Missing code"), 400);
    try {
      await app.connectors.finishOAuth(state, code);
      return c.html(page("Connected", "You can close this tab and return to Tandem.", true));
    } catch (e) {
      return c.html(page("Sign-in failed", errorMessage(e)), 400);
    }
  });

  // Everything below requires a session. JSON bodies only (CSRF defense alongside SameSite=Strict).
  api.use("*", async (c, next) => {
    if (!authed(c)) return c.json({ error: "Not signed in" }, 401);
    if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) {
      const ct = c.req.header("content-type") ?? "";
      if (c.req.header("content-length") !== "0" && ct && !ct.includes("application/json")) return c.json({ error: "JSON only" }, 415);
    }
    await next();
  });

  // ---------------- events ----------------
  api.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      const queue: string[] = [];
      let wake: (() => void) | null = null;
      const off = bus.onEvent((e) => {
        queue.push(JSON.stringify(e));
        wake?.();
      });
      stream.onAbort(() => {
        off();
        wake?.();
      });
      await stream.writeSSE({ event: "hello", data: "{}" });
      let lastPing = Date.now();
      while (!stream.aborted) {
        while (queue.length) await stream.writeSSE({ data: queue.shift()! });
        if (Date.now() - lastPing > 20_000) {
          await stream.writeSSE({ event: "ping", data: String(Date.now()) });
          lastPing = Date.now();
        }
        await new Promise<void>((r) => {
          wake = r;
          setTimeout(r, 5_000);
        });
        wake = null;
      }
      off();
    }),
  );

  // ---------------- channels & messages ----------------
  api.get("/channels", (c) => c.json(app.store.listChannels()));
  api.post("/channels", async (c) => {
    const b = await c.req.json<{ name: string; topic?: string }>();
    if (!b.name?.trim()) throw new Error("Name required");
    return c.json(app.store.createChannel(b.name.trim().slice(0, 60), b.topic?.trim() || null));
  });
  api.patch("/channels/:id", async (c) => c.json(app.store.updateChannel(c.req.param("id"), await c.req.json())));
  api.post("/channels/:id/read", (c) => {
    app.store.markRead(c.req.param("id"));
    return c.json({ ok: true });
  });
  api.get("/channels/:id/messages", (c) => {
    const before = c.req.query("before");
    return c.json(app.store.listMessages(c.req.param("id"), { before: before ? Number(before) : undefined, limit: Number(c.req.query("limit") ?? 50) }));
  });
  api.post("/channels/:id/messages", async (c) => {
    const { content } = await c.req.json<{ content: string }>();
    if (!content?.trim()) throw new Error("Empty message");
    const message = await app.agent.userMessage(c.req.param("id"), content.trim().slice(0, 50_000));
    return c.json({ message });
  });
  api.post("/channels/:id/stop", (c) => {
    app.agent.stop(c.req.param("id"));
    return c.json({ ok: true });
  });

  // ---------------- approvals ----------------
  api.get("/approvals", (c) => c.json(app.store.listApprovals((c.req.query("status") as any) || undefined)));
  api.post("/approvals/:id", async (c) => {
    const b = await c.req.json<{ decision: "approve" | "deny"; edits?: Record<string, unknown>; note?: string }>();
    if (b.decision !== "approve" && b.decision !== "deny") throw new Error("decision must be approve or deny");
    return c.json(await app.approvals.decide(c.req.param("id"), b.decision, b.edits, b.note));
  });

  // ---------------- tasks ----------------
  api.get("/tasks", (c) => c.json(app.store.listTasks()));
  api.get("/tasks/:id", (c) => {
    const task = app.store.getTask(c.req.param("id"));
    if (!task) throw new Error("Task not found");
    return c.json({ task, log: app.store.taskLog(task.id), question: app.store.taskPendingQuestion(task.id) });
  });
  api.post("/tasks", async (c) => {
    const b = await c.req.json<{ title: string; brief: string; channelId?: string }>();
    if (!b.title?.trim() || !b.brief?.trim()) throw new Error("Title and brief are required");
    const t = app.store.createTask({ channelId: b.channelId ?? "main", title: b.title.trim(), brief: b.brief.trim() });
    app.tasks.enqueue(t.id);
    return c.json(t);
  });
  api.post("/tasks/:id/complete", (c) => c.json(app.tasks.complete(c.req.param("id"))));
  api.post("/tasks/:id/cancel", (c) => c.json(app.tasks.cancel(c.req.param("id"))));
  api.post("/tasks/:id/reply", async (c) => {
    const { content } = await c.req.json<{ content: string }>();
    if (!content?.trim()) throw new Error("Empty reply");
    return c.json(app.tasks.reply(c.req.param("id"), content.trim()));
  });

  // ---------------- artifacts ----------------
  api.get("/artifacts", (c) => c.json(app.store.listArtifacts()));
  api.get("/artifacts/:id", (c) => {
    const a = app.store.getArtifact(c.req.param("id"));
    if (!a) throw new Error("Artifact not found");
    return c.json(a);
  });
  api.put("/artifacts/:id", async (c) => c.json(app.store.updateArtifact(c.req.param("id"), await c.req.json())));
  api.delete("/artifacts/:id", (c) => {
    app.store.deleteArtifact(c.req.param("id"));
    return c.json({ ok: true });
  });
  api.get("/artifacts/:id/raw", (c) => {
    const a = app.store.getArtifact(c.req.param("id"));
    if (!a) return c.text("not found", 404);
    const types: Record<string, string> = {
      html: "text/html; charset=utf-8",
      csv: "text/csv; charset=utf-8",
      json: "application/json; charset=utf-8",
      markdown: "text/markdown; charset=utf-8",
    };
    // Artifacts are model-written: render them in an opaque origin with no access to the session.
    c.header("Content-Security-Policy", "sandbox allow-scripts allow-popups allow-forms allow-modals; default-src * data: blob: 'unsafe-inline' 'unsafe-eval'");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Content-Type", types[a.kind] ?? "text/plain; charset=utf-8");
    if (c.req.query("download")) c.header("Content-Disposition", `attachment; filename="${a.title.replace(/[^\w.-]+/g, "_")}.${ext(a.kind)}"`);
    return c.body(a.content ?? "");
  });

  // ---------------- memory ----------------
  api.get("/memories", (c) => {
    const q = c.req.query("q");
    return c.json(q ? app.store.searchMemories(q, 100) : app.store.listMemories());
  });
  api.post("/memories", async (c) => {
    const b = await c.req.json<{ content: string; tags?: string[]; pinned?: boolean }>();
    if (!b.content?.trim()) throw new Error("Empty memory");
    return c.json(app.store.addMemory(b.content.trim(), b.tags ?? [], !!b.pinned, "user"));
  });
  api.patch("/memories/:id", async (c) => c.json(app.store.updateMemory(c.req.param("id"), await c.req.json())));
  api.delete("/memories/:id", (c) => {
    app.store.deleteMemory(c.req.param("id"));
    return c.json({ ok: true });
  });

  // ---------------- activity & routines ----------------
  api.get("/activity", (c) => {
    const before = c.req.query("before");
    return c.json(app.store.listActivity(Number(c.req.query("limit") ?? 100), before ? Number(before) : undefined));
  });
  api.get("/routines", (c) => c.json(app.scheduler.routines()));
  api.post("/routines", async (c) => {
    const b = await c.req.json<{ name: string; cron: string; prompt: string; channelId?: string }>();
    checkCron(b.cron, app.settings.get().timezone);
    if (!b.name?.trim() || !b.prompt?.trim()) throw new Error("Name and instructions are required");
    const id = app.store.createRoutine({ name: b.name.trim(), cron: b.cron.trim(), prompt: b.prompt.trim(), channelId: b.channelId ?? "main" });
    app.scheduler.reloadRoutines();
    return c.json(app.scheduler.routines().find((r) => r.id === id));
  });
  api.patch("/routines/:id", async (c) => {
    const b = await c.req.json<{ name?: string; cron?: string; prompt?: string; enabled?: boolean }>();
    if (b.cron) checkCron(b.cron, app.settings.get().timezone);
    app.store.updateRoutine(c.req.param("id"), b);
    app.scheduler.reloadRoutines();
    return c.json(app.scheduler.routines().find((r) => r.id === c.req.param("id")));
  });
  api.delete("/routines/:id", (c) => {
    app.store.deleteRoutine(c.req.param("id"));
    app.scheduler.reloadRoutines();
    return c.json({ ok: true });
  });
  api.post("/routines/:id/run", (c) => {
    void app.scheduler.runRoutine(c.req.param("id"), true);
    return c.json({ ok: true });
  });
  api.post("/run/brief", (c) => {
    void app.scheduler.runBrief(true);
    return c.json({ ok: true });
  });
  api.post("/run/checkin", (c) => {
    void app.scheduler.runCheckin(true);
    return c.json({ ok: true });
  });

  // ---------------- settings & providers ----------------
  api.get("/settings", (c) => c.json(app.settings.get()));
  api.patch("/settings", async (c) => {
    const patch = await c.req.json<Partial<Settings>>();
    const s = app.settings.update(patch);
    if (patch.notify?.telegram) {
      app.telegram.stop();
      app.telegram.start();
    }
    if (patch.browser) await app.browser.close();
    return c.json(s);
  });
  api.get("/providers", (c) => c.json({ providers: app.providers.list(), presets: PROVIDER_PRESETS }));
  api.put("/providers/:id", async (c) => {
    const b = await c.req.json<ProviderConfig>();
    return c.json(app.providers.save({ ...b, id: c.req.param("id") }));
  });
  api.delete("/providers/:id", (c) => {
    app.providers.remove(c.req.param("id"));
    return c.json({ ok: true });
  });
  api.get("/providers/:id/models", async (c) => {
    try {
      return c.json({ models: await app.providers.adapter(c.req.param("id")).listModels() });
    } catch (e) {
      return c.json({ models: [], error: errorMessage(e) });
    }
  });
  api.post("/providers/:id/test", async (c) => {
    const { model } = await c.req.json<{ model: string }>();
    const ref = `${c.req.param("id")}:${model}`;
    parseModelRef(ref);
    const t0 = Date.now();
    try {
      const r = await app.providers.chat(
        [ref],
        { system: { stable: "Reply with the single word: ready" }, messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }], maxTokens: 2000, effort: "low" },
        { background: false },
      );
      const text = r.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
      return c.json({ ok: true, latencyMs: Date.now() - t0, reply: text.slice(0, 100) });
    } catch (e) {
      return c.json({ ok: false, latencyMs: Date.now() - t0, error: errorMessage(e) });
    }
  });

  // ---------------- connectors & secrets ----------------
  api.get("/connectors", (c) => c.json({ connectors: app.connectors.configs(), status: app.connectors.status(), catalog: CATALOG }));
  api.put("/connectors/:id", async (c) => {
    const b = await c.req.json<ConnectorConfig>();
    return c.json(await app.connectors.save({ ...b, id: c.req.param("id") }));
  });
  api.delete("/connectors/:id", async (c) => {
    await app.connectors.remove(c.req.param("id"));
    return c.json({ ok: true });
  });
  api.post("/connectors/:id/reconnect", async (c) => {
    await app.connectors.reconnect(c.req.param("id"));
    return c.json(app.connectors.status().find((s) => s.id === c.req.param("id")));
  });
  api.get("/secrets", (c) => c.json(app.vault.list()));
  api.put("/secrets/:name", async (c) => {
    const { value } = await c.req.json<{ value: string }>();
    if (typeof value !== "string" || !value) throw new Error("Value required");
    app.vault.set(c.req.param("name"), value);
    app.providers.invalidate();
    return c.json({ ok: true });
  });
  api.delete("/secrets/:name", (c) => {
    app.vault.delete(c.req.param("name"));
    app.providers.invalidate();
    return c.json({ ok: true });
  });

  // ---------------- misc ----------------
  api.get("/skills", (c) => {
    app.skills.reload();
    return c.json(app.skills.list());
  });
  api.get("/usage", (c) => c.json(usage(app)));
  api.get("/push/key", (c) => c.json({ publicKey: app.notifier.vapid().publicKey }));
  api.post("/push/subscribe", async (c) => {
    const sub = await c.req.json<{ endpoint: string }>();
    if (!sub?.endpoint?.startsWith("https://")) throw new Error("Invalid subscription");
    app.notifier.subscribe(sub);
    return c.json({ ok: true });
  });
  api.post("/push/test", async (c) => {
    await app.notifier.send({ title: "Tandem", body: "Notifications are working.", urgent: true });
    return c.json({ ok: true });
  });
  api.post("/browser/takeover", async (c) => {
    await app.browser.takeover(await c.req.json());
    return c.json({ ok: true });
  });

  return api;
}

function checkCron(expr: string, tz: string) {
  try {
    new Cron(expr, { timezone: tz, paused: true });
  } catch (e) {
    throw new Error(`Invalid schedule: ${errorMessage(e)}`);
  }
}

function ext(kind: string) {
  return ({ markdown: "md", html: "html", csv: "csv", json: "json", code: "txt", text: "txt" } as Record<string, string>)[kind] ?? "txt";
}

function usage(app: App): UsageSummary {
  const tz = app.settings.get().timezone;
  const today = zonedParts(Date.now(), tz).date;
  const t = app.db
    .prepare(
      "SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o, COALESCE(SUM(usd),0) u, COALESCE(SUM(CASE WHEN background=1 THEN usd ELSE 0 END),0) b FROM usage WHERE day = ?",
    )
    .get(today) as any;
  const since = Date.now() - 30 * 86400_000;
  const days = app.db
    .prepare("SELECT day, SUM(usd) usd, SUM(CASE WHEN background=1 THEN usd ELSE 0 END) bg FROM usage WHERE at > ? GROUP BY day ORDER BY day")
    .all(since) as any[];
  const byModel = app.db
    .prepare("SELECT model, SUM(usd) usd, COUNT(*) calls FROM usage WHERE at > ? GROUP BY model ORDER BY usd DESC")
    .all(since) as any[];
  return {
    today: { inputTokens: t.i, outputTokens: t.o, usd: t.u, backgroundUsd: t.b },
    last30: days.map((d) => ({ day: d.day, usd: d.usd, background: d.bg })),
    byModel: byModel.map((m) => ({ model: m.model, usd: m.usd, calls: m.calls })),
  };
}

function page(title: string, body: string, ok = false) {
  const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
  return `<!doctype html><meta name="viewport" content="width=device-width"><title>${esc(title)}</title><body style="font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#f6f3ee;color:#1d1b18"><div style="text-align:center"><h1 style="font-weight:600">${ok ? "✓ " : ""}${esc(title)}</h1><p>${esc(body)}</p>${ok ? "<script>setTimeout(()=>window.close(),1500)</script>" : ""}</div>`;
}
