import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { App, ROOT } from "./app.ts";
import { createApi } from "./api/routes.ts";

export function createServer(app: App) {
  const web = new Hono();
  web.use("*", async (c, next) => {
    await next();
    c.header("X-Frame-Options", "SAMEORIGIN");
    c.header("Referrer-Policy", "same-origin");
  });
  web.route("/api", createApi(app));
  web.get("/healthz", (c) => c.json({ ok: true }));

  const dist = join(ROOT, "web", "dist");
  if (existsSync(dist)) {
    const root = relative(process.cwd(), dist) || ".";
    web.use("/*", serveStatic({ root }));
    const index = readFileSync(join(dist, "index.html"), "utf8");
    web.get("*", (c) => c.html(index)); // SPA fallback
  } else {
    web.get("/", (c) => c.text("Tandem API is running. Build the web app with `npm run build`, or run `npm run dev` and open http://localhost:5173."));
  }
  return web;
}

export function listen(app: App) {
  const server = serve({ fetch: createServer(app).fetch, port: app.config.port, hostname: app.config.host });
  return server;
}
