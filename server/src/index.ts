import { App, loadConfig } from "./app.ts";
import { listen } from "./server.ts";

const config = loadConfig();
const app = new App(config);
const server = listen(app);
await app.start();

const s = app.settings.get();
console.log(`\n  Tandem is running → ${config.publicUrl}`);
console.log(`  data: ${config.dataDir}`);
console.log(`  models: work=${s.models.work} triage=${s.models.triage}`);
if (!app.kv.get("password_hash", null)) console.log("  First run: open the URL above to set a password.\n");

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  console.log("\n  Shutting down…");
  server.close();
  await app.stop().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
