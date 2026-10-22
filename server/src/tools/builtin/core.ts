import { Cron } from "croner";
import type { ArtifactKind } from "../../shared.ts";
import type { Tool } from "../types.ts";
import { arr, bool, obj, str } from "../types.ts";
import { formatLocal, truncate } from "../../util.ts";

const ARTIFACT_KINDS: ArtifactKind[] = ["markdown", "html", "csv", "json", "code", "text"];

export const coreTools: Tool[] = [
  // ---------------- memory ----------------
  {
    name: "memory_save",
    description:
      "Save a durable fact about the user, their business, people, preferences, or standing instructions. Write it as a self-contained sentence. Pin only things that should always be in mind (e.g. 'Never email clients after 6pm').",
    parameters: obj({ content: str("The fact, self-contained"), tags: arr({ type: "string" }, "Short tags like person, client, preference"), pinned: bool("Always include in context") }, ["content"]),
    risk: "internal",
    source: "builtin",
    summarize: (a) => `Remembered: ${String(a.content).slice(0, 60)}`,
    run: async (a, { app }) => {
      const m = app.store.addMemory(String(a.content), (a.tags as string[]) ?? [], !!a.pinned, "agent");
      return `Saved memory ${m.id}.`;
    },
  },
  {
    name: "memory_search",
    description: "Search long-term memory for facts about people, clients, preferences, past decisions.",
    parameters: obj({ query: str("What to look for") }),
    risk: "read",
    source: "builtin",
    summarize: (a) => `Searched memory for “${a.query}”`,
    run: async (a, { app }) => {
      const r = app.store.searchMemories(String(a.query), 12);
      return r.length ? r.map((m) => `- (${m.id}) ${m.content}`).join("\n") : "No matching memories.";
    },
  },
  {
    name: "memory_forget",
    description: "Delete a memory that is wrong or outdated.",
    parameters: obj({ id: str("Memory id") }),
    risk: "internal",
    source: "builtin",
    summarize: () => "Forgot an outdated memory",
    run: async (a, { app }) => {
      app.store.deleteMemory(String(a.id));
      return "Deleted.";
    },
  },
  {
    name: "search_past_chats",
    description: "Full-text search across all past conversations in every channel.",
    parameters: obj({ query: str("Keywords") }),
    risk: "read",
    source: "builtin",
    summarize: (a) => `Searched past chats for “${a.query}”`,
    run: async (a, { app }) => {
      const tz = app.settings.get().timezone;
      const r = app.store.searchMessages(String(a.query), 10);
      return r.length
        ? r.map((m) => `[${formatLocal(m.createdAt, tz)} · #${m.channelId} · ${m.role}] ${truncate(m.content, 600)}`).join("\n\n")
        : "Nothing found.";
    },
  },

  // ---------------- tasks ----------------
  {
    name: "start_task",
    description:
      "Hand off a larger job to run in the background (research, building a dashboard/deck/model, multi-step follow-ups). It keeps working while the user is away and reports back in this channel. Write a complete brief: goal, context, constraints, what 'done' looks like.",
    parameters: obj({ title: str("Short title, 3–7 words"), brief: str("Complete self-contained brief") }),
    risk: "internal",
    source: "builtin",
    summarize: (a) => `Started task: ${a.title}`,
    run: async (a, { app, channelId, taskId }) => {
      if (taskId) return "You are already inside a task. Do the work directly instead of starting a sub-task.";
      const t = app.store.createTask({ channelId, title: String(a.title), brief: String(a.brief) });
      app.tasks.enqueue(t.id);
      return `Task ${t.id} started. It will report back here when it finishes or needs input. Tell the user briefly.`;
    },
  },
  {
    name: "list_tasks",
    description: "List background tasks and their status.",
    parameters: obj({}, []),
    risk: "read",
    source: "builtin",
    summarize: () => "Checked task list",
    run: async (_a, { app }) => {
      const t = app.store.listTasks().slice(0, 30);
      return t.length ? t.map((x) => `- ${x.id} [${x.status}] ${x.title}${x.progress ? ` — ${x.progress}` : ""}`).join("\n") : "No tasks.";
    },
  },
  {
    name: "task_progress",
    description: "(Task only) Record a short progress note visible on the Tasks tab.",
    parameters: obj({ note: str("One line") }),
    risk: "internal",
    source: "builtin:task",
    summarize: (a) => `Progress: ${a.note}`,
    run: async (a, { app, taskId }) => {
      if (taskId) app.store.updateTask(taskId, { progress: String(a.note) });
      return "Noted.";
    },
  },
  {
    name: "task_ask_user",
    description:
      "(Task only) You are blocked on information only the user has. Ask one clear question; the task pauses until they reply. Finish everything you can first.",
    parameters: obj({ question: str("The question") }),
    risk: "internal",
    source: "builtin:task",
    summarize: () => "Asked the user a question",
    run: async (a, { app, taskId }) => {
      if (!taskId) return "Only available inside a task — just ask in your reply.";
      app.tasks.requestInput(taskId, String(a.question));
      return "Question sent. Stop now; you'll resume when the user answers.";
    },
  },
  {
    name: "task_done",
    description:
      "(Task only) Report the task as finished with a concise summary of what was done and where the outputs are. The user decides whether it's complete.",
    parameters: obj({ summary: str("What was done, results, links to artifacts, anything still pending approval") }),
    risk: "internal",
    source: "builtin:task",
    summarize: () => "Reported task finished",
    run: async (a, { app, taskId }) => {
      if (!taskId) return "Only available inside a task.";
      app.tasks.suggestDone(taskId, String(a.summary));
      return "Reported. Stop now.";
    },
  },

  // ---------------- artifacts (Make tab) ----------------
  {
    name: "create_artifact",
    description:
      "Create a file the user can open and edit on the Make tab: reports (markdown), dashboards and prototypes (single-file html with inline CSS/JS; may load libraries from a CDN), spreadsheets (csv), data (json), code.",
    parameters: obj({
      title: str("Title"),
      kind: str("File type", { enum: ARTIFACT_KINDS }),
      content: str("Full file content"),
    }),
    risk: "internal",
    source: "builtin",
    summarize: (a) => `Made ${a.kind}: ${a.title}`,
    run: async (a, { app, taskId }) => {
      const art = app.store.createArtifact({ title: String(a.title), kind: a.kind as ArtifactKind, content: String(a.content), taskId });
      if (taskId) {
        const t = app.store.getTask(taskId);
        if (t) app.store.updateTask(taskId, { artifactIds: [...t.artifactIds, art.id] });
      }
      return { text: `Created artifact ${art.id} (“${art.title}”).`, artifactIds: [art.id] };
    },
  },
  {
    name: "update_artifact",
    description: "Replace the content of an existing artifact (new version).",
    parameters: obj({ id: str("Artifact id"), content: str("Full new content"), title: str("New title") }, ["id", "content"]),
    risk: "internal",
    source: "builtin",
    summarize: () => "Updated an artifact",
    run: async (a, { app }) => {
      const art = app.store.updateArtifact(String(a.id), { content: String(a.content), title: a.title as string | undefined });
      return { text: `Updated ${art.id} to v${art.version}.`, artifactIds: [art.id] };
    },
  },
  {
    name: "read_artifact",
    description: "Read an artifact (the user may have edited it). Omit id to list all artifacts.",
    parameters: obj({ id: str("Artifact id") }, []),
    risk: "read",
    source: "builtin",
    summarize: () => "Opened artifacts",
    run: async (a, { app }) => {
      if (!a.id) return app.store.listArtifacts().map((x) => `- ${x.id} [${x.kind}] ${x.title} (v${x.version})`).join("\n") || "No artifacts.";
      const art = app.store.getArtifact(String(a.id));
      return art ? `# ${art.title} (${art.kind}, v${art.version})\n\n${truncate(art.content ?? "", 60000)}` : "Not found.";
    },
  },

  // ---------------- routines ----------------
  {
    name: "schedule_routine",
    description:
      "Create a recurring job, e.g. 'refresh the revenue dashboard every weekday at 5:30' or 'every Friday 4pm summarize open invoices'. Uses a cron expression in the user's timezone.",
    parameters: obj({
      name: str("Name"),
      cron: str("5-field cron, e.g. '30 5 * * 1-5'"),
      prompt: str("Instructions to run each time"),
    }),
    risk: "internal",
    source: "builtin",
    summarize: (a) => `Scheduled “${a.name}” (${a.cron})`,
    run: async (a, { app, channelId }) => {
      try {
        new Cron(String(a.cron), { timezone: app.settings.get().timezone, paused: true });
      } catch (e) {
        return `Invalid cron: ${(e as Error).message}`;
      }
      const rid = app.store.createRoutine({ name: String(a.name), cron: String(a.cron), prompt: String(a.prompt), channelId });
      app.scheduler.reloadRoutines();
      const next = app.scheduler.nextRun(rid);
      return `Routine ${rid} created. Next run: ${next ? formatLocal(next, app.settings.get().timezone) : "unknown"}.`;
    },
  },
  {
    name: "list_routines",
    description: "List scheduled routines.",
    parameters: obj({}, []),
    risk: "read",
    source: "builtin",
    summarize: () => "Checked routines",
    run: async (_a, { app }) =>
      app.store.listRoutines().map((r) => `- ${r.id} ${r.enabled ? "" : "(paused) "}${r.name} [${r.cron}]: ${r.prompt.slice(0, 120)}`).join("\n") ||
      "No routines.",
  },
  {
    name: "cancel_routine",
    description: "Delete a routine.",
    parameters: obj({ id: str("Routine id") }),
    risk: "internal",
    source: "builtin",
    summarize: () => "Cancelled a routine",
    run: async (a, { app }) => {
      app.store.deleteRoutine(String(a.id));
      app.scheduler.reloadRoutines();
      return "Deleted.";
    },
  },

  // ---------------- skills ----------------
  {
    name: "load_skill",
    description: "Load the full instructions of a skill listed in your system prompt before doing that kind of work.",
    parameters: obj({ name: str("Skill name") }),
    risk: "read",
    source: "builtin",
    summarize: (a) => `Loaded skill ${a.name}`,
    run: async (a, { app }) => app.skills.read(String(a.name)),
  },

  // ---------------- channels ----------------
  {
    name: "post_to_channel",
    description: "Post a message into another channel (e.g. file a finding under its topic channel).",
    parameters: obj({ channelId: str("Channel id"), content: str("Markdown message") }),
    risk: "internal",
    source: "builtin",
    summarize: (a) => `Posted to #${a.channelId}`,
    run: async (a, { app }) => {
      if (!app.store.getChannel(String(a.channelId))) return "No such channel.";
      app.store.addMessage({ channelId: String(a.channelId), role: "assistant", kind: "chat", content: String(a.content) });
      return "Posted.";
    },
  },
];
