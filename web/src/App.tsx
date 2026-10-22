import { useCallback, useEffect, useState } from "react";
import { api, setUnauthorizedHandler } from "./api";
import { StoreProvider } from "./store";
import { Shell } from "./views/Shell";
import { Auth } from "./views/Auth";
import { Spinner } from "./components/ui";

type Gate = { state: "loading" } | { state: "setup" } | { state: "login" } | { state: "in" } | { state: "offline"; error: string };

export function App() {
  const [gate, setGate] = useState<Gate>({ state: "loading" });

  const check = useCallback(async () => {
    try {
      const me = await api.me();
      setGate(me.setupRequired ? { state: "setup" } : me.authed ? { state: "in" } : { state: "login" });
    } catch (e) {
      setGate({ state: "offline", error: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => setGate({ state: "login" }));
    void check();
  }, [check]);

  if (gate.state === "loading")
    return (
      <div className="grid h-full place-items-center text-muted">
        <Spinner />
      </div>
    );
  if (gate.state === "offline")
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div>
          <div className="font-display text-xl font-semibold">Can't reach Tandem</div>
          <p className="mt-2 text-sm text-muted">Is the server running? ({gate.error})</p>
          <button className="mt-4 text-sm text-agent underline" onClick={() => void check()}>
            Try again
          </button>
        </div>
      </div>
    );
  if (gate.state !== "in") return <Auth mode={gate.state} onDone={() => setGate({ state: "in" })} />;
  return (
    <StoreProvider>
      <Shell onLogout={() => setGate({ state: "login" })} />
    </StoreProvider>
  );
}
