import type { AlarmSoundId, DeviceAdapter, Locale, WebDAVCredentials } from "./DeviceAdapter";

/**
 * Slice-1 in-memory `DeviceAdapter` stub backing the renderer when no
 * shell-injected adapter is present on `window.cookietodoDeviceAdapter`.
 *
 * Backed by `localStorage` — values persist across page reloads in this
 * session but ARE NOT in the OS keychain. This is REPLACED by Electron
 * `safeStorage` -> OS keychain in slice 2 via the preload script; the
 * `DeviceAdapter` interface is not changing shape (slice 2 swaps persistence
 * behind the same TS surface).
 *
 * Used by `App.tsx` only when `window.cookietodoDeviceAdapter` is undefined —
 * i.e. the preload has not yet (or did not) inject a shell-specific adapter.
 */
const STORAGE_PREFIX = "cookietodo.device.";
const KEY_LOCALE = `${STORAGE_PREFIX}locale`;
const KEY_DISMISS_PASSWORD = `${STORAGE_PREFIX}dismiss-password`;
const KEY_ALARM_SOUND_ID = `${STORAGE_PREFIX}alarm-sound-id`;
const KEY_WEBDAV_PREFIX = `${STORAGE_PREFIX}webdav.`;

function isLocale(v: unknown): v is Locale {
  return v === "zh-CN" || v === "en-US";
}

function isAlarmSoundId(v: unknown): v is AlarmSoundId {
  return typeof v === "number" && v >= 1 && v <= 5;
}

function localStorageOrThrow(): Storage {
  if (typeof globalThis.localStorage === "undefined") {
    throw new Error("electronRendererStub requires DOM localStorage — preload adapter missing");
  }
  return globalThis.localStorage;
}

export const electronRendererStub: DeviceAdapter = {
  getLocale(): Locale | null {
    const raw = localStorageOrThrow().getItem(KEY_LOCALE);
    return isLocale(raw) ? raw : null;
  },
  saveLocale(locale: Locale): void {
    localStorageOrThrow().setItem(KEY_LOCALE, locale);
  },
  getDismissPassword(): string | null {
    return localStorageOrThrow().getItem(KEY_DISMISS_PASSWORD) ?? null;
  },
  saveDismissPassword(password: string): void {
    localStorageOrThrow().setItem(KEY_DISMISS_PASSWORD, password);
  },
  getAlarmSoundId(): AlarmSoundId | null {
    const raw = localStorageOrThrow().getItem(KEY_ALARM_SOUND_ID);
    const n = raw === null ? NaN : Number(raw);
    return isAlarmSoundId(n) ? n : null;
  },
  saveAlarmSoundId(id: AlarmSoundId): void {
    localStorageOrThrow().setItem(KEY_ALARM_SOUND_ID, String(id));
  },
  getWebDAVCredentials(url: string): WebDAVCredentials | null {
    const raw = localStorageOrThrow().getItem(`${KEY_WEBDAV_PREFIX}${url}`);
    if (raw === null) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<WebDAVCredentials>;
      if (typeof parsed.user !== "string" || typeof parsed.pass !== "string") {
        return null;
      }
      return { user: parsed.user, pass: parsed.pass };
    } catch {
      return null;
    }
  },
  saveWebDAVCredentials(url: string, credentials: WebDAVCredentials): void {
    localStorageOrThrow().setItem(`${KEY_WEBDAV_PREFIX}${url}`, JSON.stringify(credentials));
  },
};
