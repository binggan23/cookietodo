import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DeviceAdapter, Locale } from "./device/DeviceAdapter";
import { electronRendererStub } from "./device/electronRendererStub";
import i18next, { pickInitialLocale } from "./i18n";

/**
 * Slice-1 root view.
 *
 * Two-screen state machine within one component:
 *   - `picker`: language selector (简体中文 / English) shown when no saved
 *     locale is found (ADR 0010 first-launch language picker precedes the
 *     ADR 0009 password-setup screen — password lands in slice 2).
 *   - `hello`: the single-screen "hello cookietodo" placeholder (i18next key,
 *     not literal text — ADR 0010 mandates `t('key')` for all UI strings).
 *
 * The picker persists the chosen locale via `DeviceAdapter.saveLocale()` then
 * transitions. When a saved locale already exists, the picker is skipped.
 */
type Screen = "picker" | "hello";

function resolveDeviceAdapter(): DeviceAdapter {
  // Slice 2: the Electron preload replaces this stub with a `safeStorage`-
  // backed adapter exposed via `window.cookietodoDeviceAdapter()`. Slice 1
  // has no such injection, so we always fall back to the localStorage stub.
  return window.cookietodoDeviceAdapter?.() ?? electronRendererStub;
}

export function App(): JSX.Element {
  const { t, i18n } = useTranslation();
  const [screen, setScreen] = useState<Screen>("picker");
  const [pendingPick, setPendingPick] = useState<Locale | null>(null);

  // Initial: ask the shell for any saved locale, fall back via ADR 0010
  // three-step detection. If detection yields a saved preference, skip the
  // picker and go straight to "hello".
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-time-only one-shot initializer; reads module-level `i18next` (not the hook's `i18n` dep) and runs once on first paint.
  useEffect(() => {
    const adapter = resolveDeviceAdapter();
    const deviceLocale = adapter.getLocale();
    const initial = pickInitialLocale(deviceLocale, navigator?.language);
    if (deviceLocale !== null) {
      void i18next.changeLanguage(initial);
      setScreen("hello");
      return;
    }
    // No saved preference yet: show the picker, pre-select the detected locale
    // so the highlighted button matches the user's likely choice.
    void i18next.changeLanguage(initial);
    setPendingPick(initial);
  }, [i18n]);

  function handlePick(locale: Locale): void {
    setPendingPick(locale);
    void i18next.changeLanguage(locale);
  }

  function handleContinue(): void {
    const chosen = pendingPick;
    if (chosen === null) {
      return;
    }
    resolveDeviceAdapter().saveLocale(chosen);
    setScreen("hello");
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
        <button type="button" onClick={handleContinue} disabled={pendingPick === null}>
          {t("first-launch.continue")}
        </button>
      </main>
    );
  }

  return (
    <main className="hello-screen" data-testid="hello-screen">
      <h1>{t("hello")}</h1>
    </main>
  );
}
