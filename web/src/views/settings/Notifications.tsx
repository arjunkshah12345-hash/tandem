import { BellRing, Send } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, Field, Input, Toggle } from "../../components/ui";
import { api, CommitInput, errText, Group, Row, Section, useSettings } from "./common";

function b64ToBytes(b64: string) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function enablePush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error("This browser doesn't support push. On iPhone, add Tandem to your Home Screen first.");
  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Notifications are blocked for this site.");
  const { publicKey } = await api.pushKey();
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) }));
  await api.subscribePush(sub.toJSON());
}

export function NotificationsSection() {
  const { settings: s, save, flash } = useSettings();
  const n = s.notify;
  const [pushState, setPushState] = useState<"unknown" | "on" | "off">("unknown");
  const [tgToken, setTgToken] = useState("");

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return setPushState("off");
    navigator.serviceWorker.getRegistration().then(async (r) => setPushState((await r?.pushManager.getSubscription()) ? "on" : "off"));
  }, []);

  const ntfy = n.ntfy ?? { enabled: false, server: "https://ntfy.sh", topic: "" };
  const tg = n.telegram ?? { enabled: false, botTokenSecret: "TELEGRAM_BOT_TOKEN", chatId: null };
  const hook = n.webhook ?? { enabled: false, url: "" };

  return (
    <Section
      title="Notifications"
      description="How Tandem gets your attention when something needs you. Approvals and finished tasks are urgent; everything else respects quiet hours."
    >
      <Group
        title="This device"
        action={
          <Button size="sm" variant="ghost" onClick={() => api.testPush().then(() => flash("Test sent"), (e) => flash(errText(e), true))}>
            <Send size={13} /> Send test
          </Button>
        }
      >
        <Toggle checked={n.webPush} onChange={(v) => save({ notify: { webPush: v } })} label="Browser & phone push" hint="Works on desktop browsers, Android, and iPhone once Tandem is added to the Home Screen." />
        <Row label={pushState === "on" ? "This device is subscribed" : "Subscribe this device"}>
          <Button
            size="sm"
            variant={pushState === "on" ? "quiet" : "primary"}
            onClick={() =>
              enablePush().then(
                () => {
                  setPushState("on");
                  flash("Push enabled");
                },
                (e) => flash(errText(e), true),
              )
            }
          >
            <BellRing size={13} /> {pushState === "on" ? "Re-subscribe" : "Enable"}
          </Button>
        </Row>
      </Group>

      <Group title="Telegram — chat and approve from your phone">
        <Toggle checked={tg.enabled} onChange={(v) => save({ notify: { telegram: { ...tg, enabled: v } } })} label="Use a Telegram bot" hint="Message Tandem, get briefs, and tap Approve / Not now right in Telegram." />
        <div className="space-y-3 py-3">
          <Field label="Bot token" hint="Create a bot with @BotFather and paste its token. Then send your bot any message — Tandem pairs with the first chat that writes to it.">
            <div className="flex gap-2">
              <Input type="password" value={tgToken} onChange={(e) => setTgToken(e.target.value)} placeholder="123456:ABC…" autoComplete="off" />
              <Button
                variant="primary"
                disabled={!tgToken.trim()}
                onClick={async () => {
                  try {
                    await api.setSecret(tg.botTokenSecret, tgToken.trim());
                    setTgToken("");
                    await save({ notify: { telegram: { ...tg, enabled: true } } });
                  } catch (e) {
                    flash(errText(e), true);
                  }
                }}
              >
                Save
              </Button>
            </div>
          </Field>
          <Row label="Paired chat" hint="Clear this to pair a different chat.">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[13px] text-muted">{tg.chatId ?? "not paired yet"}</span>
              {tg.chatId ? (
                <Button size="sm" variant="ghost" onClick={() => save({ notify: { telegram: { ...tg, chatId: null } } })}>
                  Unpair
                </Button>
              ) : null}
            </div>
          </Row>
        </div>
      </Group>

      <Group title="ntfy">
        <Toggle checked={ntfy.enabled} onChange={(v) => save({ notify: { ntfy: { ...ntfy, enabled: v } } })} label="Send to an ntfy topic" hint="Free, open-source push to any phone via the ntfy app. Pick an unguessable topic name." />
        <Row label="Server">
          <CommitInput value={ntfy.server} onCommit={(v) => save({ notify: { ntfy: { ...ntfy, server: v } } })} className="sm:w-64" />
        </Row>
        <Row label="Topic">
          <CommitInput value={ntfy.topic} onCommit={(v) => save({ notify: { ntfy: { ...ntfy, topic: v } } })} placeholder="tandem-7f3k2q" className="sm:w-64" />
        </Row>
      </Group>

      <Group title="Webhook">
        <Toggle checked={hook.enabled} onChange={(v) => save({ notify: { webhook: { ...hook, enabled: v } } })} label="POST notifications as JSON" hint="For Slack/Discord incoming webhooks, Home Assistant, or your own automations." />
        <Row label="URL">
          <CommitInput value={hook.url} onCommit={(v) => save({ notify: { webhook: { ...hook, url: v } } })} placeholder="https://hooks.slack.com/…" className="sm:w-80" />
        </Row>
      </Group>
    </Section>
  );
}
