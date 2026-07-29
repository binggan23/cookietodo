import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import type { Locale } from "../device/DeviceAdapter";
import enUS from "./locales/en-US.json";
import zhCN from "./locales/zh-CN.json";

/**
 * i18next config per ADR 0010.
 *
 * Compile-time catalogs (option A per ADR 0010 Rationale): both zh-CN and
 * en-US bundles are statically imported here, no per-locale runtime fetch.
 *
 * Default `lng` is `zh-CN` per ADR 0010 fall-back chain:
 *   1) user-chosen preference persisted by DeviceAdapter
 *   2) OS locale (when both DeviceAdapter returns null and `navigator.language`
 *      matches one of our supported locales)
 *   3) `zh-CN` fallback for any other detected locale.
 *
 * Caller ({@link../App.tsx}) calls {@link pickInitialLocale} and invokes
 * `i18next.changeLanguage(locale)` after mount.
 */
void i18next.use(initReactI18next).init({
  resources: {
    "zh-CN": { translation: zhCN },
    "en-US": { translation: enUS },
  },
  lng: "zh-CN",
  fallbackLng: "zh-CN",
  supportedLngs: ["zh-CN", "en-US"],
  interpolation: { escapeValue: false },
});

/**
 * Resolve the initial UI locale using ADR 0010's three-step detection order.
 *
 * @param deviceLocale - whatever the {@link DeviceAdapter} returns from
 *   `getLocale()` (may be `null` if user has not yet picked).
 * @param navigatorLanguage - `navigator.language` (passed explicitly so this
 *   module stays testable in non-DOM contexts).
 * @returns the locale to use at first render.
 */
export function pickInitialLocale(
  deviceLocale: Locale | null,
  navigatorLanguage: string | undefined,
): Locale {
  if (deviceLocale === "zh-CN" || deviceLocale === "en-US") {
    return deviceLocale;
  }
  if (navigatorLanguage?.toLowerCase().startsWith("en")) {
    return "en-US";
  }
  return "zh-CN";
}

export default i18next;
