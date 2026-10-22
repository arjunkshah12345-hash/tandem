import clsx from "clsx";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Settings } from "@shared";
import { api, type DeepPartial } from "../api";
import { Spinner } from "../components/ui";
import { navigate, useQueryState } from "../util";
import { SettingsContext } from "./settings/common";
import { ConnectorsSection } from "./settings/Connectors";
import { MemorySection, SecretsSection, SkillsSection } from "./settings/Library";
import { ModelsSection } from "./settings/Models";
import { NotificationsSection } from "./settings/Notifications";
import { ProfileSection, SafetySection, ScheduleSection } from "./settings/General";
import { UsageSection } from "./settings/Usage";

const SECTIONS = [
  { id: "profile", label: "Profile" },
  { id: "models", label: "Models" },
  { id: "connectors", label: "Connected apps" },
  { id: "schedule", label: "Schedule" },
  { id: "safety", label: "Safety" },
  { id: "notifications", label: "Notifications" },
  { id: "memory", label: "Memory" },
  { id: "skills", label: "Skills" },
  { id: "secrets", label: "Secrets" },
  { id: "usage", label: "Usage" },
] as const;

export function SettingsView() {
  const q = useQueryState();
  const section = q.get("section") || "profile";
  const [settings, setSettings] = useState<Settings | null>(null);
  const [toast, setToast] = useState<{ msg: string; error: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    api.settings().then(setSettings).catch(() => {});
  }, []);

  const flash = useCallback((msg: string, error = false) => {
    setToast({ msg, error });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), error ? 5000 : 1800);
  }, []);

  const save = useCallback(
    async (patch: DeepPartial<Settings>) => {
      try {
        setSettings(await api.saveSettings(patch));
        flash("Saved");
      } catch (e) {
        flash(e instanceof Error ? e.message : String(e), true);
        api.settings().then(setSettings).catch(() => {});
      }
    },
    [flash],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <nav className="scroll-thin flex shrink-0 gap-1 overflow-x-auto border-b border-line px-3 py-2 md:w-[200px] md:flex-col md:overflow-visible md:border-b-0 md:border-r md:px-3 md:py-8">
        <div className="hidden px-2.5 pb-3 font-display text-[22px] font-semibold tracking-tight md:block">Settings</div>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            onClick={() => navigate({ section: s.id }, true)}
            className={clsx(
              "h-8 shrink-0 rounded-lg px-2.5 text-left text-[13.5px] transition md:h-9",
              section === s.id ? "bg-card font-medium text-ink shadow-[0_1px_0_var(--line)]" : "text-muted hover:bg-sunk hover:text-ink",
            )}
          >
            {s.label}
          </button>
        ))}
      </nav>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[760px] px-4 py-6 md:px-10 md:py-10">
          {!settings ? (
            <div className="flex justify-center py-16 text-faint">
              <Spinner />
            </div>
          ) : (
            <SettingsContext.Provider value={{ settings, save, flash }}>
              {section === "profile" ? <ProfileSection /> : null}
              {section === "models" ? <ModelsSection /> : null}
              {section === "connectors" ? <ConnectorsSection /> : null}
              {section === "schedule" ? <ScheduleSection /> : null}
              {section === "safety" ? <SafetySection /> : null}
              {section === "notifications" ? <NotificationsSection /> : null}
              {section === "memory" ? <MemorySection /> : null}
              {section === "skills" ? <SkillsSection /> : null}
              {section === "secrets" ? <SecretsSection /> : null}
              {section === "usage" ? <UsageSection /> : null}
            </SettingsContext.Provider>
          )}
        </div>
      </div>
      {toast ? (
        <div
          className={clsx(
            "animate-rise fixed bottom-20 left-1/2 z-50 -translate-x-1/2 rounded-full px-4 py-2 text-[13px] font-medium shadow-lg md:bottom-6",
            toast.error ? "bg-danger text-white" : "bg-ink text-paper",
          )}
        >
          {toast.msg}
        </div>
      ) : null}
    </div>
  );
}
