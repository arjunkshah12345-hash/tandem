import { App, loadConfig } from "./app.ts";
import { hashPassword } from "./api/routes.ts";
import { parseModelRef } from "./providers/registry.ts";

const [cmd, ...rest] = process.argv.slice(2);

async function main() {
  switch (cmd) {
    case undefined:
    case "start":
      await import("./index.ts");
      return;

    case "doctor": {
      const app = new App(loadConfig());
      const s = app.settings.get();
      const line = (ok: boolean, label: string, extra = "") => console.log(`  ${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
      console.log("\nTandem doctor\n");
      line(Number(process.versions.node.split(".")[0]) >= 22, `Node ${process.versions.node}`, "needs ≥ 22.13");
      line(!!app.kv.get("password_hash", null), "Password set", "open the web UI to set one");
      for (const ref of [s.models.work, s.models.triage]) {
        try {
          const { providerId } = parseModelRef(ref);
          app.providers.adapter(providerId);
          line(true, `Model ${ref}`);
        } catch (e) {
          line(false, `Model ${ref}`, (e as Error).message);
        }
      }
      await app.connectors.start();
      for (const st of app.connectors.status()) line(st.state === "connected", `Connector ${st.id}`, st.error ?? `${st.tools.length} tools`);
      try {
        await import("playwright-core");
        line(true, "Browser support (playwright-core)");
      } catch {
        line(false, "Browser support", "npm i playwright-core");
      }
      await app.stop();
      console.log("");
      return;
    }

    case "reset-password": {
      const pw = rest[0];
      if (!pw || pw.length < 8) throw new Error("Usage: tandem reset-password <new-password (8+ chars)>");
      const app = new App(loadConfig());
      app.kv.set("password_hash", hashPassword(pw));
      app.db.prepare("DELETE FROM sessions").run();
      console.log("Password updated; all sessions signed out.");
      await app.stop();
      return;
    }

    case "secret": {
      const [name, value] = rest;
      if (!name || !value) throw new Error("Usage: tandem secret <NAME> <value>");
      const app = new App(loadConfig());
      app.vault.set(name, value);
      console.log(`Stored ${name}.`);
      await app.stop();
      return;
    }

    default:
      console.log(`Usage: tandem [start|doctor|reset-password <pw>|secret <NAME> <value>]`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
