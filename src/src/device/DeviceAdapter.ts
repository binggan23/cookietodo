/**
 * DeviceAdapter — per-device preference store interface (ADR 0009 + ADR 0010).
 *
 * Implementations live in the native shells:
 *   - {@link apps/electron/preload/index.ts} (Electron: localStorage stub for v1;
 *     replaced by `safeStorage` -> OS keychain in slice 2).
 *   - {@link apps/android/} Capacitor + Android Keystore (slice 10).
 *
 * The methods are synchronous because the slice-1 Electron stub reads from
 * `localStorage`; the production keychain-backed implementations added in
 * later slices will wrap these in async patterns and the call sites will be
 * updated then. Slice 1 keeps the surface synchronous to land the
 * language-picker -> hello flow today.
 *
 * None of these values travel the Snapshot (ADR 0001).
 */
export type Locale = "zh-CN" | "en-US";

export type AlarmSoundId = 1 | 2 | 3 | 4 | 5;

export interface WebDAVCredentials {
  user: string;
  pass: string;
}

export interface DeviceAdapter {
  /** The user-chosen UI language; null until first-launch language picker. */
  getLocale(): Locale | null;
  saveLocale(locale: Locale): void;

  /** 6-digit alarm dismiss password (set on first launch per ADR 0009 Decision B). */
  getDismissPassword(): string | null;
  saveDismissPassword(password: string): void;

  /** 1..5 selected alarm tone id (per ADR 0009 Decision A). */
  getAlarmSoundId(): AlarmSoundId | null;
  saveAlarmSoundId(id: AlarmSoundId): void;

  /** Per-device WebDAV credentials (per ADR 0008 + ADR 0010); keyed by endpoint URL. */
  getWebDAVCredentials(url: string): WebDAVCredentials | null;
  saveWebDAVCredentials(url: string, credentials: WebDAVCredentials): void;
}

/**
 * The window-global injected by the Electron preload script (or, in pure-web
 * test contexts, a fake). Renderers should read `window.cookietodoDeviceAdapter()`
 * once on mount to obtain the {@link DeviceAdapter} for the current shell.
 *
 * Slice 1's Electron preload sets this on `window` via `contextBridge.exposeInMainWorld`.
 */
declare global {
  interface Window {
    cookietodoDeviceAdapter?: () => DeviceAdapter;
  }
}
