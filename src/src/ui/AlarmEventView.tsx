import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AlarmAdapter } from "../alarm/AlarmAdapter";
import { MAX_SNOOZES } from "../alarm/snoozeConfig";
import type { DeviceAdapter } from "../device/DeviceAdapter";
import i18next, { pickInitialLocale } from "../i18n";
import { PasswordInput } from "./PasswordInput";

/**
 * Slice-6 Alarm Event fullscreen view (ADR 0007 + ADR 0009).
 *
 * Rendered by the Electron shell inside the dedicated alarm `BrowserWindow`
 * (loaded at `#/alarm?reminderId=…&todoId=…&todoTitle=…&soundUrl=…&snoozeCount=…`).
 * Shows the owning Todo's title, plays the alarm tone (default #1) via
 * `<audio autoplay loop>`, and offers the ADR 0007 Decision A surface:
 *   - a 6-digit password pad — the ONLY dismiss path (correct code ⇒ the
 *     shell closes the window and the store atomically completes the Todo);
 *   - a Snooze button — the no-password path, rendered only while
 *     `snoozeCount < MAX_SNOOZES` (ADR 0007 Decision C: exactly 3 attempts,
 *     so at `snoozeCount >= 3` the button disappears).
 *
 * Wrong passwords only increment a local counter and clear the pad (ADR 0007
 * AC #4: no rate limit, the alarm never resumes earlier). A `busy` flag guards
 * against double-invoke while an IPC round-trip is in flight.
 *
 * Props are resolved from the URL hash by `main.tsx` (the hash gate). The
 * component is intentionally dumb — no store access — so the shell's window
 * lifecycle owns all the state.
 */
interface Props {
  reminderId: string;
  todoTitle: string;
  soundUrl: string;
  snoozeCount: number;
}

export function AlarmEventView({
  reminderId,
  todoTitle,
  soundUrl,
  snoozeCount,
}: Props): JSX.Element {
  const { t, i18n } = useTranslation();
  const [password, setPassword] = useState("");
  const [wrongAttempts, setWrongAttempts] = useState(0);
  const [busy, setBusy] = useState(false);
  const alarmAdapterRef = useRef<AlarmAdapter | null>(null);
  const deviceAdapterRef = useRef<DeviceAdapter | null>(null);

  // Read the shell-injected adapters lazily (window may not have them in
  // Vitest / headless preview — actions degrade to no-op, no crash).
  useEffect(() => {
    alarmAdapterRef.current = window.cookietodoAlarmAdapter?.() ?? null;
    deviceAdapterRef.current = window.cookietodoDeviceAdapter?.() ?? null;
  }, []);

  // Resolve the device locale exactly like App.tsx — the slice-5 alarm window
  // rendered the default zh-CN regardless of user locale; this closes that gap.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-time-only one-shot initializer; reads module-level `i18next` (not the hook's `i18n` dep) and runs once on first paint.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const deviceLocale = await window.cookietodoDeviceAdapter?.().getLocale();
      if (cancelled) {
        return;
      }
      const initial = pickInitialLocale(deviceLocale ?? null, navigator?.language);
      void i18next.changeLanguage(initial);
    })();
    return () => {
      cancelled = true;
    };
  }, [i18n]);

  async function handleSnooze(): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    const adapter = alarmAdapterRef.current;
    if (adapter !== null) {
      // The shell closes the alarm window on success — busy stays set and the
      // component unmounts; no need to unlock here.
      await adapter.snoozeAlarm(reminderId);
    }
  }

  async function handlePasswordChange(next: string): Promise<void> {
    setPassword(next);
    if (busy || next.length !== 6) {
      return;
    }
    setBusy(true);
    const alarmAdapter = alarmAdapterRef.current;
    const deviceAdapter = deviceAdapterRef.current;
    if (alarmAdapter === null || deviceAdapter === null) {
      // No shell — nothing to validate against; clear the pad and unlock.
      setBusy(false);
      setPassword("");
      return;
    }
    const dismissPassword = await deviceAdapter.getDismissPassword();
    if (dismissPassword !== null && dismissPassword === next) {
      // Correct code — the shell closes the window (busy stays set; the
      // component unmounts).
      await alarmAdapter.dismissAlarm(reminderId);
      return;
    }
    // Wrong password (or null — shouldn't happen post-first-launch): count the
    // attempt, clear the pad for re-entry, never resume the alarm earlier.
    setWrongAttempts((n) => n + 1);
    setPassword("");
    setBusy(false);
  }

  const showSnooze = snoozeCount < MAX_SNOOZES;

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
      {showSnooze && (
        <button
          type="button"
          data-testid="alarm-event.snooze"
          onClick={() => void handleSnooze()}
          disabled={busy}
        >
          {t("alarm.event-snooze")}
        </button>
      )}
      <fieldset className="alarm-event-password">
        <legend className="visually-hidden">{t("alarm.event-password-label")}</legend>
        <PasswordInput
          value={password}
          onChange={(next) => void handlePasswordChange(next)}
          invalid={wrongAttempts > 0}
          ariaLabelForSlot={(i) => `${t("alarm.event-password-label")} ${i + 1}`}
        />
      </fieldset>
      {wrongAttempts > 0 && (
        <p
          role="alert"
          data-testid="alarm-event.wrong-password"
          className="alarm-event-wrong-password"
        >
          {t("alarm.event-wrong-password")}
        </p>
      )}
    </main>
  );
}
