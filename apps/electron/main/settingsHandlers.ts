import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Snapshot } from "@cookietodo/renderer/domain";
import { dialog, ipcMain, type OpenDialogReturnValue } from "electron";
import { parseSnapshot, serializeSnapshot } from "./snapshotIO.js";

const CHANNEL_PREFIX = "cookietodo:settings:";

function channelFor(method: "exportSnapshot" | "importSnapshot"): string {
  return `${CHANNEL_PREFIX}${method}`;
}

const DEFAULT_EXPORT_NAME = "snapshot.todo.json";

const FILE_FILTERS = [
  { name: "cookietodo Snapshot", extensions: ["todo.json", "json"] },
  { name: "All Files", extensions: ["*"] },
];

/**
 * E2E seam: when `COOKIETODO_E2E_FAKE_DIALOG_DIR` is set, the native
 * `dialog.show*` calls are short-circuited to deterministic { canceled:false,
 * filePath(s): <envDir>/<fixed-name> } answers — the e2e harness pre-writes a
 * fixture file at the import path and asserts the export path's bytes. Mirrors
 * slice-2's `COOKIETODO_E2E_INSECURE_DEVICE_STORE` convention for safeStorage
 * mock — opt-in env gate so production dialog behaviour is untouched.
 */
const FAKE_DIALOG_DIR = process.env.COOKIETODO_E2E_FAKE_DIALOG_DIR ?? "";
const FAKE_OPEN_NAME = process.env.COOKIETODO_E2E_FAKE_OPEN_NAME ?? "import.todo.json";
const FAKE_SAVE_NAME = process.env.COOKIETODO_E2E_FAKE_SAVE_NAME ?? "export.todo.json";

function fakeDialogEnabled(): boolean {
  return FAKE_DIALOG_DIR.length > 0;
}

async function showSaveDialog(): Promise<{ canceled: boolean; filePath?: string }> {
  if (fakeDialogEnabled()) {
    return { canceled: false, filePath: join(FAKE_DIALOG_DIR, FAKE_SAVE_NAME) };
  }
  return dialog.showSaveDialog({
    title: "Export cookietodo Snapshot",
    defaultPath: DEFAULT_EXPORT_NAME,
    filters: FILE_FILTERS,
  });
}

async function showOpenDialog(): Promise<OpenDialogReturnValue> {
  if (fakeDialogEnabled()) {
    return { canceled: false, filePaths: [join(FAKE_DIALOG_DIR, FAKE_OPEN_NAME)] };
  }
  return dialog.showOpenDialog({
    title: "Import cookietodo Snapshot",
    filters: FILE_FILTERS,
    properties: ["openFile"],
  });
}

export function registerSettingsAdapterIpc(): void {
  ipcMain.handle(
    channelFor("exportSnapshot"),
    async (_event, snapshot: Snapshot): Promise<string | null> => {
      const result = await showSaveDialog();
      if (result.canceled || result.filePath === undefined || result.filePath === "") {
        return null;
      }
      await writeFile(result.filePath, serializeSnapshot(snapshot), "utf8");
      return result.filePath;
    },
  );

  ipcMain.handle(channelFor("importSnapshot"), async (): Promise<Snapshot | null> => {
    const result = await showOpenDialog();
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    const filePath = result.filePaths[0];
    if (filePath === undefined) {
      return null;
    }
    const text = await readFile(filePath, "utf8");
    return parseSnapshot(text);
  });
}
