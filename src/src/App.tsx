import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DeviceAdapter, Locale } from "./device/DeviceAdapter";
import { electronRendererStub } from "./device/electronRendererStub";
import i18next, { pickInitialLocale } from "./i18n";
import { HomeView } from "./ui/HomeView";
import { PasswordInput } from "./ui/PasswordInput";

/**
 * Root view of the first-launch flow (slice 2): language picker → 6-digit
 * password setup → confirm → home. Per ADR 0010 the language picker comes
 * first; per ADR 0009 Decision B password setup is forced on first app launch
 * and never skippable.
 *
 * State machine:
 *   - `booting`   — adapter reads in flight; render a blank placeholder.
 *   - `picker`    — language select (shown only when no saved locale exists).
 *   - `setup`     — 6-digit password entry; mismatch loops back here per ADR
 *   - `confirm`   — re-entry; mismatch loops back to `setup` with a banner.
 *   - `home`      — post-setup hello screen (`home.welcome` key).
 *
 * Routing decisions on mount (saved locale + saved password both async
 * `DeviceAdapter` reads — ADR 0010 + ADR 0009 surface):
 *   - both present           → `home` (subsequent launches skip the flow).
 *   - locale present, password missing → `setup` (picker is skipped).
 *   - locale missing         → `picker` (password lands after).
 *
 * All visible strings route through `t('namespace.key')` (ADR 0010).
 */
type Screen = "booting" | "picker" | "setup" | "confirm" | "home";

const DIGITS_PATTERN = /^\d{6}$/;

function resolveDeviceAdapter(): DeviceAdapter {
  // Slice-2 Electron preload returns the `safeStorage`-backed adapter (IPC
  // proxy to the main-process store). When this is undefined the renderer is
  // running without the preload (Vitest, headless Vite preview): fall back to
  // the localStorage-backed stub.
  return window.cookietodoDeviceAdapter?.() ?? electronRendererStub;
}

export function App(): JSX.Element {
  const { t, i18n } = useTranslation();
  const [screen, setScreen] = useState<Screen>("booting");
  const [pendingPick, setPendingPick] = useState<Locale | null>(null);
  const [stagedPassword, setStagedPassword] = useState<string>("");
  const [confirmPassword, setConfirmPassword] = useState<string>("");
  const [mismatched, setMismatched] = useState<boolean>(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-time-only one-shot initializer; reads module-level `i18next` (not the hook's `i18n` dep) and runs once on first paint.
  useEffect(() => {
    let cancelled = false;
    const adapter = resolveDeviceAdapter();
    void (async () => {
      const [deviceLocale, devicePassword] = await Promise.all([
        adapter.getLocale(),
        adapter.getDismissPassword(),
      ]);
      if (cancelled) {
        return;
      }
      const initial = pickInitialLocale(deviceLocale, navigator?.language);
      void i18next.changeLanguage(initial);
      if (deviceLocale !== null && devicePassword !== null) {
        setScreen("home");
        return;
      }
      if (deviceLocale !== null) {
        setScreen("setup");
        return;
      }
      setPendingPick(initial);
      setScreen("picker");
    })();
    return () => {
      cancelled = true;
    };
  }, [i18n]);

  function handlePick(locale: Locale): void {
    setPendingPick(locale);
    void i18next.changeLanguage(locale);
  }

  async function handleLanguageContinue(): Promise<void> {
    const chosen = pendingPick;
    if (chosen === null) {
      return;
    }
    setScreen("booting");
    await resolveDeviceAdapter().saveLocale(chosen);
    setScreen("setup");
  }

  function handlePasswordContinue(next: string): void {
    setStagedPassword(next);
    if (!DIGITS_PATTERN.test(next)) {
      return;
    }
    setConfirmPassword("");
    setMismatched(false);
    setScreen("confirm");
  }

  async function handleConfirmContinue(): Promise<void> {
    if (!DIGITS_PATTERN.test(confirmPassword)) {
      return;
    }
    if (confirmPassword !== stagedPassword) {
      // ADR 0009 Decision B: mismatch loops back, no rate-limit, no hint, no
      // frozen state.
      setMismatched(true);
      setStagedPassword("");
      setConfirmPassword("");
      setScreen("setup");
      return;
    }
    setScreen("booting");
    await resolveDeviceAdapter().saveDismissPassword(confirmPassword);
    setScreen("home");
  }

  function handleBackToSetup(): void {
    setStagedPassword("");
    setConfirmPassword("");
    setMismatched(false);
    setScreen("setup");
  }

  if (screen === "picker") {
    return (
      <main className="picker-screen">
        <h1>{t("first-launch.language-prompt")}</h1>
        <fieldset>
          <legend className="visually-hidden">{t("first-launch.language-prompt")}</legend>
          <button
            type="button"
            onClick={() => handlePick("zh-CN")}
            aria-pressed={pendingPick === "zh-CN"}
          >
            {t("first-launch.language-zh")}
          </button>
          <button
            type="button"
            onClick={() => handlePick("en-US")}
            aria-pressed={pendingPick === "en-US"}
          >
            {t("first-launch.language-en")}
          </button>
        </fieldset>
        <button
          type="button"
          onClick={() => void handleLanguageContinue()}
          disabled={pendingPick === null}
        >
          {t("first-launch.continue")}
        </button>
      </main>
    );
  }

  if (screen === "setup") {
    return (
      <main className="password-screen" data-testid="password-setup-screen">
        <h2>{t("first-launch.password.welcome")}</h2>
        <h1>{t("first-launch.password.setup-prompt")}</h1>
        <p>{t("first-launch.password.setup-summary")}</p>
        {mismatched && (
          <p role="alert" className="mismatch-banner">
            {t("first-launch.password.mismatch")}
          </p>
        )}
        <PasswordInput value={stagedPassword} onChange={handlePasswordContinue} />
      </main>
    );
  }

  if (screen === "confirm") {
    return (
      <main className="password-screen" data-testid="password-confirm-screen">
        <h1>{t("first-launch.password.confirm-prompt")}</h1>
        <p>{t("first-launch.password.confirm-summary")}</p>
        <PasswordInput value={confirmPassword} onChange={setConfirmPassword} invalid={false} />
        <button
          type="button"
          onClick={() => void handleConfirmContinue()}
          disabled={!DIGITS_PATTERN.test(confirmPassword)}
        >
          {t("first-launch.password.continue")}
        </button>
        <button type="button" onClick={handleBackToSetup}>
          {t("first-launch.password.back")}
        </button>
      </main>
    );
  }

  if (screen === "home") {
    return (
      <main className="hello-screen" data-testid="hello-screen">
        <h1>{t("home.welcome")}</h1>
        <HomeView />
      </main>
    );
  }

  // booting
  return <main className="booting-screen" data-testid="booting-screen" aria-busy="true" />;
}
