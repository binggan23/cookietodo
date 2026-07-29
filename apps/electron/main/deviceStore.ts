import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AlarmSoundId,
  DeviceAdapter,
  Locale,
  WebDAVCredentials,
} from "@cookietodo/renderer/device";
import { app, safeStorage } from "electron";

/**
 * Slice-2 main-process `DeviceAdapter` backed by Electron `safeStorage`
 * (ADR 0009 Decision B + ADR 0010).
 *
 * Persistence layout: a single JSON file at `app.getPath('userData')/device-store.json`
 * holding a small typed envelope. Inside the envelope:
 *   - `locale` (non-secret per ADR 0001 — UI language preference) — plaintext string.
 *   - `alarmSoundId` (non-secret per ADR 0001) — plaintext number.
 *   - `dismissPassword` (secret per ADR 0009) — base64 cipher from
 *     `safeStorage.encryptString(password)`. Stored INSIDE the same JSON for
 *     atomic read/write — the cipher is opaque without OS credentials.
 *   - `webdav` — `{ [url]: { user, pass } }` where `user` and `pass` are base64
 *     ciphers (the user field is treated as a credential too — surfacing it
 *     plaintext would tie the dismiss-password-cracking cost to grepping
 *     userData files). Per ADR 0008's per-device credential model.
 *
 * The dismiss password and WebDAV credentials are encrypted with
 * `safeStorage.encryptString` (main-process-only) — these are SECRETS and
 * must never round-trip as plaintext through the renderer. Sync accessors that
 * touch cipher bytes throw {@link DeviceAdapterUnavailable} when
 * `safeStorage.isEncryptionAvailable()` returns false (no `libsecret` /
 * `gnome-keyring-daemon` on Linux) per the librarian recommendation + ADR 0009.
 * The non-secret accessors (`getLocale`/`saveLocale`/`getAlarmSoundId`/
 * `saveAlarmSoundId`) work without keyring — they are not security-critical
 * per ADR 0001's preference classification.
 *
 * None of these values travel the Snapshot (ADR 0001).
 */

interface DeviceStoreEnvelope {
  locale: Locale | null;
  alarmSoundId: AlarmSoundId | null;
  /** Base64 cipher from `safeStorage.encryptString`. `null` when no password set. */
  dismissPasswordCipher: string | null;
  /** Per-endpoint WebDAV credentials — values are base64 ciphers. */
  webdav: Record<string, StoredWebDAVCredentials>;
}

interface StoredWebDAVCredentials {
  /** Base64 cipher. */
  userCipher: string;
  /** Base64 cipher. */
  passCipher: string;
}

const EMPTY_ENVELOPE: DeviceStoreEnvelope = {
  locale: null,
  alarmSoundId: null,
  dismissPasswordCipher: null,
  webdav: {},
};

/**
 * Thrown by credential-typing accessors when `safeStorage.isEncryptionAvailable()`
 * returns false. Surfaced to the renderer over IPC as a rejected Promise; the
 * renderer decides UX (ADR 0009 mandates refusing-to-start is preferable to
 * plaintext fallback, so the renderer treats this as "no dismiss password
 * readable" + a blocking error per ADR 0008 failure-mode UX).
 *
 * In practice: a desktop without `libsecret`/`gnome-keyring` cannot ever store
 * the dismiss password safely, so the renderer refuses to enter the
 * first-launch password-setup screen and instead shows a credentials-missing
 * modal (out-of-scope for slice 2's literal acceptance criteria — the slice 2
 * e2e runs in a CI env that has the keyring daemon).
 */
export class DeviceAdapterUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceAdapterUnavailable";
  }
}

function storePath(): string {
  return join(app.getPath("userData"), "device-store.json");
}

function isLocale(v: unknown): v is Locale {
  return v === "zh-CN" || v === "en-US";
}

function isAlarmSoundId(v: unknown): v is AlarmSoundId {
  return typeof v === "number" && v >= 1 && v <= 5;
}

async function readEnvelope(): Promise<DeviceStoreEnvelope> {
  try {
    const raw = await readFile(storePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<DeviceStoreEnvelope>;
    return {
      locale: isLocale(parsed.locale) ? parsed.locale : null,
      alarmSoundId: isAlarmSoundId(parsed.alarmSoundId) ? parsed.alarmSoundId : null,
      dismissPasswordCipher:
        typeof parsed.dismissPasswordCipher === "string" ? parsed.dismissPasswordCipher : null,
      webdav:
        parsed.webdav && typeof parsed.webdav === "object" && !Array.isArray(parsed.webdav)
          ? (parsed.webdav as Record<string, StoredWebDAVCredentials>)
          : {},
    };
  } catch {
    // Missing, unreadable, or malformed store means first-launch (no
    // persisted preference yet).
    return { ...EMPTY_ENVELOPE };
  }
}

async function writeEnvelope(env: DeviceStoreEnvelope): Promise<void> {
  await writeFile(storePath(), JSON.stringify(env, null, 2), "utf8");
}

function assertEncryptionAvailable(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new DeviceAdapterUnavailable(
      "safeStorage encryption unavailable — install libsecret / gnome-keyring-daemon or run on a keyring-enabled OS (slice 2 ADR 0009)",
    );
  }
}

/**
 * Build the main-process `DeviceAdapter` whose methods `registerDeviceAdapterIpc`
 * delegates to. The Electron main process is the canonical safe-storage owner
 * per the Electron docs (safeStorage is main-process-only).
 *
 * The methods are synchronous-safe wrappers (read/write file + cipher
 * transformation); they're invoked from `ipcMain.handle` so they return
 * Promises to the renderer.
 */
export function createDeviceStore(): DeviceAdapter {
  return {
    async getLocale(): Promise<Locale | null> {
      const env = await readEnvelope();
      return env.locale;
    },
    async saveLocale(locale: Locale): Promise<void> {
      const env = await readEnvelope();
      env.locale = locale;
      await writeEnvelope(env);
    },

    async getDismissPassword(): Promise<string | null> {
      const env = await readEnvelope();
      if (env.dismissPasswordCipher === null) {
        return null;
      }
      assertEncryptionAvailable();
      const cipher = Buffer.from(env.dismissPasswordCipher, "base64");
      return safeStorage.decryptString(cipher);
    },
    async saveDismissPassword(password: string): Promise<void> {
      assertEncryptionAvailable();
      const cipher = safeStorage.encryptString(password);
      const env = await readEnvelope();
      env.dismissPasswordCipher = cipher.toString("base64");
      await writeEnvelope(env);
    },

    async getAlarmSoundId(): Promise<AlarmSoundId | null> {
      const env = await readEnvelope();
      return env.alarmSoundId;
    },
    async saveAlarmSoundId(id: AlarmSoundId): Promise<void> {
      const env = await readEnvelope();
      env.alarmSoundId = id;
      await writeEnvelope(env);
    },

    async getWebDAVCredentials(url: string): Promise<WebDAVCredentials | null> {
      const env = await readEnvelope();
      const stored = env.webdav[url];
      if (!stored) {
        return null;
      }
      assertEncryptionAvailable();
      return {
        user: safeStorage.decryptString(Buffer.from(stored.userCipher, "base64")),
        pass: safeStorage.decryptString(Buffer.from(stored.passCipher, "base64")),
      };
    },
    async saveWebDAVCredentials(url: string, credentials: WebDAVCredentials): Promise<void> {
      assertEncryptionAvailable();
      const userCipher = safeStorage.encryptString(credentials.user).toString("base64");
      const passCipher = safeStorage.encryptString(credentials.pass).toString("base64");
      const env = await readEnvelope();
      env.webdav = { ...env.webdav, [url]: { userCipher, passCipher } };
      await writeEnvelope(env);
    },
  };
}
