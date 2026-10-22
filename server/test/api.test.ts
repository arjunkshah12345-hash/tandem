import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server.ts";
import { makeApp, text } from "./helpers.ts";

test("API: first-run setup, sessions, auth wall, secrets never echoed", async () => {
  const { app, cleanup } = makeApp(() => [text("hi")]);
  try {
    const web = createServer(app);
    const req = (path: string, init: RequestInit & { cookie?: string } = {}) =>
      web.request(`http://localhost/api${path}`, {
        ...init,
        headers: { "content-type": "application/json", ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.headers ?? {}) },
      });

    assert.deepEqual(await (await req("/me")).json(), { authed: false, setupRequired: true, userName: "" });
    assert.equal((await req("/channels")).status, 401);
    assert.equal((await req("/setup", { method: "POST", body: JSON.stringify({ password: "short" }) })).status, 400);

    const setup = await req("/setup", { method: "POST", body: JSON.stringify({ password: "correct horse", userName: "Sam", timezone: "America/Chicago" }) });
    assert.equal(setup.status, 200);
    const cookie = setup.headers.get("set-cookie")!.split(";")[0];
    assert.match(setup.headers.get("set-cookie")!, /HttpOnly/);
    assert.match(setup.headers.get("set-cookie")!, /SameSite=Strict/);
    assert.equal(app.settings.get().timezone, "America/Chicago");
    assert.equal((await req("/setup", { method: "POST", body: JSON.stringify({ password: "another one" }) })).status, 409);

    assert.equal((await req("/login", { method: "POST", body: JSON.stringify({ password: "nope nope" }) })).status, 401);
    assert.equal((await req("/login", { method: "POST", body: JSON.stringify({ password: "correct horse" }) })).status, 200);

    const channels = await (await req("/channels", { cookie })).json();
    assert.equal(channels[0].id, "main");

    await req("/secrets/OPENAI_API_KEY", { method: "PUT", cookie, body: JSON.stringify({ value: "sk-test-123456" }) });
    const secrets = await (await req("/secrets", { cookie })).json();
    assert.deepEqual(secrets.map((s: any) => Object.keys(s).sort()), [["createdAt", "name"]]);
    assert.ok(!JSON.stringify(secrets).includes("sk-test"));

    const providers = await (await req("/providers", { cookie })).json();
    assert.ok(providers.providers.find((p: any) => p.id === "openai").enabled, "provider auto-enables once its key exists");
    assert.ok(providers.presets.length >= 15);

    const bad = await req("/settings", { method: "PATCH", cookie, body: JSON.stringify({ timezone: "Mars/Olympus" }) });
    assert.equal(bad.status, 400);

    // Form posts are rejected (CSRF defense in depth).
    const form = await web.request("http://localhost/api/channels", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: "name=x" });
    assert.equal(form.status, 415);

    const art = app.store.createArtifact({ title: "Dash", kind: "html", content: "<script>alert(1)</script>" });
    const raw = await req(`/artifacts/${art.id}/raw`, { cookie });
    assert.match(raw.headers.get("content-security-policy")!, /^sandbox allow-scripts/);
    assert.doesNotMatch(raw.headers.get("content-security-policy")!, /allow-same-origin/);
  } finally {
    await cleanup();
  }
});
