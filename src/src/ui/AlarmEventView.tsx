import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AlarmAdapter } from "../alarm/AlarmAdapter";

/**
 * Slice-5 Alarm Event fullscreen view (ADR 0007 + AC #3/#5/#7).
 *
 * Rendered by the Electron shell inside the dedicated alarm `BrowserWindow`
 * (loaded at `#/alarm?reminderId=…&todoId=…&todoTitle=…&soundUrl=…&soundId=…`).
 * Bare-bones per slice-5 scope: shows the owning Todo's title, plays the alarm
 * tone (default #1) via `<audio autoplay loop>`, and offers a single flat
 * `Dismiss` button.
 *
 * Dismiss (slice-5 placeholder): calls `cancelAlarm(reminderId)` on the
 * renderer's AlarmAdapter proxy — the Electron main closes the Alarm Event
 * window. Per AC #5 the Reminder's state machine does NOT transition on this
 * Dismiss (stays `'fired'`); the password-based dismissal + `complete=true`
 * semantics land in slice 6.
 *
 * Props are resolved from the URL hash by `App.tsx` (the hash gate). The
 * component is intentionally dumb — no store access, no adapter resolution
 * beyond the `cancelAlarm` Dismiss — so it stays trivially testable and the
 * shell's window lifecycle owns all the state.
 */
interface Props {
  reminderId: string;
  todoTitle: string;
  soundUrl: string;
}

export function AlarmEventView({ reminderId, todoTitle, soundUrl }: Props): JSX.Element {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(false);
  const alarmAdapterRef = useRef<AlarmAdapter | null>(null);

  // Read the shell-injected AlarmAdapter lazily (window may not have it in
  // Vitest / headless preview — Dismiss degrades to no-op, no crash).
  useEffect(() => {
    alarmAdapterRef.current = window.cookietodoAlarmAdapter?.() ?? null;
  }, []);

  async function handleDismiss(): Promise<void> {
    if (dismissed) return;
    setDismissed(true);
    const adapter = alarmAdapterRef.current;
    if (adapter !== null) {
      await adapter.cancelAlarm(reminderId);
    }
  }

  return (
    <main className="alarm-event" data-testid="alarm-event">
      <h1 className="alarm-event-title">{t("alarm.event-title")}</h1>
      <p className="alarm-event-subtitle">
        {t("alarm.event-subtitle")}
        <span data-testid="alarm-event.todo-title">{todoTitle}</span>
      </p>
      {/* biome-ignore lint/a11y/useMediaCaption: the alarm tone is a synthesized
          sine wave (ADR 0009) with no dialogue or lyrics — captions are
          semantically inapplicable to a non-verbal alert tone. */}
      <audio
        src={soundUrl}
        autoPlay
        loop
        data-testid="alarm-event.audio"
        aria-label="alarm sound"
      />
      <button
        type="button"
        data-testid="alarm-event.dismiss"
        onClick={() => void handleDismiss()}
        disabled={dismissed}
      >
        {t("alarm.event-dismiss")}
      </button>
    </main>
  );
}
