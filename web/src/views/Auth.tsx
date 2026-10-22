import { useState, type FormEvent } from "react";
import { api } from "../api";
import { Button, Field, Input, Textarea } from "../components/ui";

export function Auth({ mode, onDone }: { mode: "setup" | "login"; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "setup") await api.setup({ password, userName: name.trim(), timezone, about: about.trim() || undefined });
      else await api.login(password);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center px-5 py-10">
      <form onSubmit={submit} className="animate-rise w-full max-w-sm">
        <img src="/icon.svg" alt="" className="mb-6 size-12 rounded-2xl" />
        <h1 className="font-display text-3xl font-semibold tracking-tight">{mode === "setup" ? "Meet Tandem" : "Welcome back"}</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-muted">
          {mode === "setup"
            ? "An assistant that works alongside you: it watches your inbox and calendar, takes on tasks, and checks with you before anything leaves the building."
            : "Sign in to pick up where you left off."}
        </p>
        <div className="mt-8 space-y-4">
          {mode === "setup" ? (
            <>
              <Field label="What should Tandem call you?">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" autoFocus autoComplete="name" />
              </Field>
              <Field label="What do you work on?" hint="Optional. A sentence or two helps the first brief land.">
                <Textarea rows={3} value={about} onChange={(e) => setAbout(e.target.value)} placeholder="I run a 6-person design studio; clients email me about invoices and timelines…" />
              </Field>
            </>
          ) : null}
          <Field label={mode === "setup" ? "Choose a password" : "Password"} hint={mode === "setup" ? `At least 8 characters. Timezone: ${timezone}` : undefined}>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus={mode === "login"}
              autoComplete={mode === "setup" ? "new-password" : "current-password"}
              minLength={mode === "setup" ? 8 : undefined}
              required
            />
          </Field>
          {error ? <p className="text-sm text-danger">{error}</p> : null}
          <Button type="submit" variant="primary" className="w-full" busy={busy}>
            {mode === "setup" ? "Get started" : "Sign in"}
          </Button>
        </div>
      </form>
    </div>
  );
}
