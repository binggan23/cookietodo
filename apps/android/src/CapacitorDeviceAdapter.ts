/**
 * CapacitorDeviceAdapter — DeviceAdapter backed by Android Keystore (secrets)
 * and @capacitor/preferences (non-secret settings) per ADR 0009 + ADR 0010.
 *
 * Secret data (dismiss password, WebDAV credentials) are stored via the
 * CookietodoAlarm plugin bridge → EncryptedSharedPreferences → Android
 * Keystore. Non-secret settings (locale, alarmSoundId, syncInterval) use
 * the Capacitor Preferences plugin (plain SharedPreferences).
 *
 * PUBLIC SURFACE: injected into `window.cookietodoDeviceAdapter` by the
 * Android app shell (Capacitor WebView bootstrap).
 */
import type {
  AlarmSoundId,
  DeviceAdapter,
  Locale,
  SyncIntervalMinutes,
  WebDAVCredentials,
} from "@cookietodo/renderer/device";
import { Preferences } from "@capacitor/preferences";
import { Capacitor } from "@capacitor/core";

// ── Capacitor plugin bridge ──────────────────────────────────────────────

/**
 * Access the native CookietodoAlarm plugin registered in MainActivity.
 * Cast to `any` because the plugin is registered at runtime via
 * `registerPlugin` and may not be typed.
 */
const AlarmPlugin = Capacitor.Plugins.CookietodoAlarm as {
  schedule(options: { reminder: Record<string, unknown>; todo: Record<string, unknown> }): Promise<void>;
  cancel(options: { reminderId: string }): Promise<void>;
  dismissAlarm(options: { reminderId: string }): Promise<void>;
  snoozeAlarm(options: { reminderId: string }): Promise<void>;
  closeAlarmWindow(options: { reminderId: string }): Promise<void>;
  requestPermission(options: { kind: string }): Promise<{ result: string }>;
  onAlarmFired(): Promise<void>;
  getDismissPassword(): Promise<{ password?: string }>;
  saveDismissPassword(options: { password: string }): Promise<void>;
  getWebDAVCredentials(options: { url: string }): Promise<{ user?: string; pass?: string }>;
  saveWebDAVCredentials(options: { url: string; user: string; pass: string }): Promise<void>;
};

// ── Preference keys ──────────────────────────────────────────────────────

const PREF_PREFIX = "cookietodo.device.";
const KEY_LOCALE = `${PREF_PREFIX}locale`;
const KEY_ALARM_SOUND_ID = `${PREF_PREFIX}alarm-sound-id`;
const KEY_SYNC_INTERVAL = `${PREF_PREFIX}sync-interval`;

// ── Type guards ──────────────────────────────────────────────────────────

function isLocale(v: unknown): v is Locale {
  return v === "zh-CN" || v === "en-US";
}

function isAlarmSoundId(v: unknown): v is AlarmSoundId {
  return typeof v === "number" && v >= 1 && v <= 5;
}

function isSyncInterval(v: unknown): v is SyncIntervalMinutes {
  return v === 1 || v === 5 || v === 15 || v === 30 || v === 60;
}

// ── Adapter class ────────────────────────────────────────────────────────

export class CapacitorDeviceAdapter implements DeviceAdapter {
  // ── Locale (non-secret) ──────────────────────────────────────────────

  async getLocale(): Promise<Locale | null> {
    const { value } = await Preferences.get({ key: KEY_LOCALE });
    return isLocale(value) ? value : null;
  }

  async saveLocale(locale: Locale): Promise<void> {
    await Preferences.set({ key: KEY_LOCALE, value: locale });
  }

  // ── Dismiss password (secret → plugin) ───────────────────────────────

  async getDismissPassword(): Promise<string | null> {
    try {
      const { password } = await AlarmPlugin.getDismissPassword();
      return password ?? null;
    } catch {
      return null;
    }
  }

  async saveDismissPassword(password: string): Promise<void> {
    await AlarmPlugin.saveDismissPassword({ password });
  }

  // ── Alarm sound id (non-secret) ──────────────────────────────────────

  async getAlarmSoundId(): Promise<AlarmSoundId | null> {
    const { value } = await Preferences.get({ key: KEY_ALARM_SOUND_ID });
    const n = value === null ? NaN : Number(value);
    return isAlarmSoundId(n) ? n : null;
  }

  async saveAlarmSoundId(id: AlarmSoundId): Promise<void> {
    await Preferences.set({ key: KEY_ALARM_SOUND_ID, value: String(id) });
  }

  // ── WebDAV credentials (secret → plugin) ─────────────────────────────

  async getWebDAVCredentials(url: string): Promise<WebDAVCredentials | null> {
    try {
      const result = await AlarmPlugin.getWebDAVCredentials({ url });
      if (result.user !== undefined && result.pass !== undefined) {
        return { user: result.user, pass: result.pass };
      }
      return null;
    } catch {
      return null;
    }
  }

  async saveWebDAVCredentials(url: string, credentials: WebDAVCredentials): Promise<void> {
    await AlarmPlugin.saveWebDAVCredentials({
      url,
      user: credentials.user,
      pass: credentials.pass,
    });
  }

  // ── Sync interval (non-secret) ───────────────────────────────────────

  async getSyncInterval(): Promise<SyncIntervalMinutes | null> {
    const { value } = await Preferences.get({ key: KEY_SYNC_INTERVAL });
    const n = value === null ? NaN : Number(value);
    return isSyncInterval(n) ? n : null;
  }

  async saveSyncInterval(minutes: SyncIntervalMinutes): Promise<void> {
    await Preferences.set({ key: KEY_SYNC_INTERVAL, value: String(minutes) });
  }
}