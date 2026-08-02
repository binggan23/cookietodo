import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AlarmEventView } from "./ui/AlarmEventView";
import "./i18n";
import "./styles.css";

/**
 * Renderer entry — routes between the Alarm Event fullscreen window and the
 * main app window by the URL hash (slice-5 design fork #8: the Alarm Event
 * window is a separate Electron BrowserWindow loading the SAME renderer
 * bundle at `#/alarm?reminderId=…&todoId=…&todoTitle=…&soundUrl=…`).
 *
 * The two windows' React trees are disjoint and stable per window, so routing
 * at the root (instead of inside `App`) keeps the Rules of Hooks intact: the
 * Alarm Event window always renders `<AlarmEventView>`, the main window always
 * renders `<App>`. Neither ever re-navigates to the other route at runtime.
 */
interface AlarmRouteParams {
  reminderId: string;
  todoTitle: string;
  soundUrl: string;
}

/**
 * Parse `location.hash` — returns `null` (main window) unless the hash starts
 * with `#/alarm` AND carries a resolvable `reminderId` + `soundUrl` (a
 * hand-typed / truncated URL degrades to the main window rather than a blank
 * alarm screen).
 */
function parseAlarmHash(hash: string): AlarmRouteParams | null {
  if (!hash.startsWith("#/alarm")) return null;
  const params = new URLSearchParams(hash.slice("#/alarm".length));
  const reminderId = params.get("reminderId");
  const soundUrl = params.get("soundUrl");
  if (reminderId === null || soundUrl === null || soundUrl === "") return null;
  return {
    reminderId,
    todoTitle: params.get("todoTitle") ?? "",
    soundUrl,
  };
}

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Root element #root not found in index.html");
}

const alarmRoute = parseAlarmHash(window.location.hash);

createRoot(rootEl).render(
  <StrictMode>
    {alarmRoute !== null ? (
      <AlarmEventView
        reminderId={alarmRoute.reminderId}
        todoTitle={alarmRoute.todoTitle}
        soundUrl={alarmRoute.soundUrl}
      />
    ) : (
      <App />
    )}
  </StrictMode>,
);
