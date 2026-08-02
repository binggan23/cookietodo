/**
 * Slice 5 — alarm-sound asset resolution for the desktop shell.
 *
 * ADR 0009 mandates the 5 alarm tones ship at `src/assets/alarm-sounds/` (the
 * renderer-package workspace-relative path) so both shells share one asset
 * source of truth. The desktop main process serves them over a custom
 * `cookietodo-sound://` protocol instead of a bare `file://` URL because the
 * Alarm Event window loads the SAME renderer bundle in two modes:
 *
 *   - dev: `http://localhost:5173/#/alarm?…` (Vite dev server)
 *   - prod: `file://<renderer>/dist/index.html#/alarm?…` (`loadFile`)
 *
 * Chromium's web security model forbids an `http://` page from loading a
 * `file://` media resource ("Not allowed to load local resource"). A
 * privileged custom scheme works in BOTH modes (it is registered via
 * `registerSchemesAsPrivileged` + `protocol.handle`, served by the main
 * process from the asset directory), so the alarm tone audibly plays whether
 * the window was loaded from the dev server or from disk.
 *
 * Layout:
 *   - `registerAlarmSoundScheme()` — MUST be called before `app.whenReady()`
 *     (Electron requires `registerSchemesAsPrivileged` before ready).
 *   - `registerAlarmSoundProtocol()` — MUST be called inside `app.whenReady()`
 *     (after the app is ready), before any Alarm Event window can fire.
 *   - `resolveAlarmSoundUrl(soundId)` — returns the `cookietodo-sound://` URL
 *     the renderer embeds in its `<audio src>`.
 *
 * Asset location:
 *   - dev: `<workspace>/src/assets/alarm-sounds/tone{N}.mp3` (the renderer
 *     source tree — the dev build does NOT bundle them; the main reads the
 *     source tree raw). Walk from `dist-electron/main/` up 4 dirs to the
 *     workspace root.
 *   - prod: `pnpm build:main` (`apps/electron/package.json`) copies the
 *     directory into `dist-electron/assets/alarm-sounds/`; the main reads from
 *     there (mirror of the existing `cp preload/index.cjs …` step).
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AlarmSoundId } from "@cookietodo/renderer/device";
import { net, protocol } from "electron";

const __dirname_subst = dirname(fileURLToPath(import.meta.url));
const isDev = process.env.ELECTRON_IS_DEV === "1";

const SOUND_SCHEME = "cookietodo-sound";

function alarmSoundsDir(): string {
  if (isDev) {
    // dist-electron/main → dist-electron → apps/electron → apps → workspace.
    return join(__dirname_subst, "..", "..", "..", "..", "src", "assets", "alarm-sounds");
  }
  return join(__dirname_subst, "..", "assets", "alarm-sounds");
}

/**
 * Declare the custom scheme as privileged BEFORE `app.whenReady()`. Required
 * so `protocol.handle` can serve the scheme later (Electron API contract).
 * `stream: true` + `supportFetchAPI: true` let `<audio>` consume it as a
 * media stream.
 */
export function registerAlarmSoundScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SOUND_SCHEME,
      privileges: { stream: true, supportFetchAPI: true, secure: true },
    },
  ]);
}

/**
 * Serve `cookietodo-sound://local/tone{N}.mp3` from the alarm-sounds dir.
 * Called inside `app.whenReady()`. An unknown file resolves via `net.fetch` to
 * a nonexistent path and rejects — surfaced to the `<audio>` element as a load
 * error (the window still renders; the tone just won't play).
 */
export function registerAlarmSoundProtocol(): void {
  protocol.handle(SOUND_SCHEME, (request) => {
    const url = new URL(request.url);
    const fileName = url.pathname.split("/").pop() ?? "";
    const filePath = join(alarmSoundsDir(), fileName);
    return net.fetch(pathToFileURL(filePath).toString());
  });
}

/** The `<audio src>` URL for the given sound id (1..5). */
export function resolveAlarmSoundUrl(soundId: AlarmSoundId): string {
  return `${SOUND_SCHEME}://local/tone${soundId}.mp3`;
}
