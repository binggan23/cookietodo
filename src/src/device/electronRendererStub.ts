import type {
  AlarmSoundId,
  DeviceAdapter,
  Locale,
  SyncIntervalMinutes,
  WebDAVCredentials,
} from "./DeviceAdapter";

/**
 * Slice-2 in-memory `DeviceAdapter` stub backing the renderer when no
 * shell-injected adapter is present on `window.cookietodoDeviceAdapter`.
 *
 * Backed by `localStorage` — values persist across page reloads in this
 * session but ARE NOT in the OS keychain. This shim is used only when the
 * Electron preload has not (yet) injected a `safeStorage`-backed adapter
 * (slice 2's preload does; this is the pure-web / test fallback).
 *
 * All methods are async (`Promise`-returning) to match the slice-2
 * `DeviceAdapter` surface — the Electron preload proxy routes through
 * `ipcRenderer.invoke`, so the renderer must `await` every call; this stub
 * never leaves the renderer thread so the underlying `localStorage` reads
 * are wrapped in `Promise.resolve` to preserve the contract shape.
 *
 * The dismiss password is stored in `localStorage` ONLY because this stub
 * is a fallback for contexts that lack the Electron preload (e.g. Vitest
 * with no shell). The production Electron path never uses this stub — it
 * receives the `safeStorage`-backed adapter via `window.cookietodoDeviceAdapter`.
 */
const STORAGE_PREFIX = "cookietodo.device.";
const KEY_LOCALE = `${STORAGE_PREFIX}locale`;
const KEY_DISMISS_PASSWORD = `${STORAGE_PREFIX}dismiss-password`;
const KEY_ALARM_SOUND_ID = `${STORAGE_PREFIX}alarm-sound-id`;
const KEY_WEBDAV_PREFIX = `${STORAGE_PREFIX}webdav.`;
const KEY_SYNC_INTERVAL = `${STORAGE_PREFIX}sync-interval`;

function isLocale(v: unknown): v is Locale {
  return v === "zh-CN" || v === "en-US";
}

function isAlarmSoundId(v: unknown): v is AlarmSoundId {
  return typeof v === "number" && v >= 1 && v <= 5;
}

function isSyncInterval(v: unknown): v is SyncIntervalMinutes {
  return v === 1 || v === 5 || v === 15 || v === 30 || v === 60;
}

function localStorageOrThrow(): Storage {
  if (typeof globalThis.localStorage === "undefined") {
    throw new Error("electronRendererStub requires DOM localStorage — preload adapter missing");
  }
  return globalThis.localStorage;
}

export const electronRendererStub: DeviceAdapter = {
  async getLocale(): Promise<Locale | null> {
    const raw = localStorageOrThrow().getItem(KEY_LOCALE);
    return isLocale(raw) ? raw : null;
  },
  async saveLocale(locale: Locale): Promise<void> {
    localStorageOrThrow().setItem(KEY_LOCALE, locale);
  },
  async getDismissPassword(): Promise<string | null> {
    return localStorageOrThrow().getItem(KEY_DISMISS_PASSWORD) ?? null;
  },
  async saveDismissPassword(password: string): Promise<void> {
    localStorageOrThrow().setItem(KEY_DISMISS_PASSWORD, password);
  },
  async getAlarmSoundId(): Promise<AlarmSoundId | null> {
    const raw = localStorageOrThrow().getItem(KEY_ALARM_SOUND_ID);
    const n = raw === null ? NaN : Number(raw);
    return isAlarmSoundId(n) ? n : null;
  },
  async saveAlarmSoundId(id: AlarmSoundId): Promise<void> {
    localStorageOrThrow().setItem(KEY_ALARM_SOUND_ID, String(id));
  },
  async getWebDAVCredentials(url: string): Promise<WebDAVCredentials | null> {
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
  async saveWebDAVCredentials(url: string, credentials: WebDAVCredentials): Promise<void> {
    localStorageOrThrow().setItem(`${KEY_WEBDAV_PREFIX}${url}`, JSON.stringify(credentials));
  },
  async getSyncInterval(): Promise<SyncIntervalMinutes | null> {
    const raw = localStorageOrThrow().getItem(KEY_SYNC_INTERVAL);
    const n = raw === null ? NaN : Number(raw);
    return isSyncInterval(n) ? n : null;
  },
  async saveSyncInterval(minutes: SyncIntervalMinutes): Promise<void> {
    localStorageOrThrow().setItem(KEY_SYNC_INTERVAL, String(minutes));
  },
};
