/**
 * DeviceAdapter — per-device preference store interface (ADR 0009 + ADR 0010).
 *
 * Implementations live in the native shells:
 *   - {@link apps/electron/preload/index.ts} (Electron: `safeStorage` ->
 *     OS keychain via main-process IPC, slice 2).
 *   - {@link apps/android/} Capacitor + Android Keystore (slice 10).
 *
 * Every method is async because the Electron 30 sandboxed-renderer canonical
 * pattern runs `safeStorage.encryptString` in the main process and reaches it
 * via `ipcRenderer.invoke` (returns a Promise through the `contextBridge`).
 * `sendSync` is deprecated and deadlocks under concurrent calls
 * ([electron/electron#22727](https://github.com/electron/electron/issues/22727)),
 * so the surface is async from slice 2 onward; the slice-1 in-memory
 * `localStorage` stub (which never leaves the renderer) is wrapped in
 * `Promise.resolve` to match.
 *
 * None of these values travel the Snapshot (ADR 0001). The dismiss password
 * and WebDAV credentials MUST round-trip through `safeStorage.encryptString`
 * (`safeStorage` is main-process-only); the locale and alarm-sound id are
 * non-secret per ADR 0001's preference classification and may live as
 * plaintext JSON inside the same OS-keyring-backed file.
 */
export type Locale = "zh-CN" | "en-US";

export type AlarmSoundId = 1 | 2 | 3 | 4 | 5;

export interface WebDAVCredentials {
  user: string;
  pass: string;
}

export interface DeviceAdapter {
  /** The user-chosen UI language; null until first-launch language picker. */
  getLocale(): Promise<Locale | null>;
  saveLocale(locale: Locale): Promise<void>;

  /** 6-digit alarm dismiss password (set on first launch per ADR 0009 Decision B). */
  getDismissPassword(): Promise<string | null>;
  saveDismissPassword(password: string): Promise<void>;

  /** 1..5 selected alarm tone id (per ADR 0009 Decision A). */
  getAlarmSoundId(): Promise<AlarmSoundId | null>;
  saveAlarmSoundId(id: AlarmSoundId): Promise<void>;

  /** Per-device WebDAV credentials (per ADR 0008 + ADR 0010); keyed by endpoint URL. */
  getWebDAVCredentials(url: string): Promise<WebDAVCredentials | null>;
  saveWebDAVCredentials(url: string, credentials: WebDAVCredentials): Promise<void>;
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
