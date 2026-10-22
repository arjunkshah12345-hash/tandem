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
      const pw = await readSecret("New password (8+ characters): ");
      if (pw.length < 8) throw new Error("Password must be at least 8 characters.");
      const app = new App(loadConfig());
      app.kv.set("password_hash", hashPassword(pw));
      app.db.prepare("DELETE FROM sessions").run();
      console.log("Password updated; all sessions signed out.");
      await app.stop();
      return;
    }

    case "secret": {
      // `tandem secret NAME` prompts (or reads stdin), so the value never lands in shell history.
      const name = rest[0] === "set" ? rest[1] : rest[0];
      if (!name) throw new Error("Usage: tandem secret <NAME>   (value is read from a hidden prompt or stdin)");
      const value = await readSecret(`Value for ${name}: `);
      if (!value) throw new Error("Empty value.");
      const app = new App(loadConfig());
      app.vault.set(name, value);
      console.log(`Stored ${name}.`);
      await app.stop();
      return;
    }

    default:
      console.log(`Usage: tandem [start|doctor|reset-password|secret <NAME>]`);
  }
}

/** Read a line without echoing it (TTY), or the whole of stdin when piped. */
async function readSecret(promptText: string): Promise<string> {
  if (!process.stdin.isTTY) {
    let data = "";
    for await (const chunk of process.stdin) data += chunk;
    return data.replace(/\r?\n$/, "");
  }
  process.stdout.write(promptText);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          process.stdout.write("\n");
          return resolve(value);
        }
        if (ch === "\u0003") {
          cleanup();
          return reject(new Error("Cancelled"));
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    process.stdin.on("data", onData);
  });
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
