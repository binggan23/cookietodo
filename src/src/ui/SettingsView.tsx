import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { StoreAdapter } from "../persistence/StoreAdapter";
import type { SettingsAdapter } from "../settings/SettingsAdapter";
import {
  useError,
  useReplaceSnapshot,
  useRevertLastMerge,
  useSnapshot,
  useSync,
} from "../store/hooks";
import type { HistoryEntry } from "../sync/history";
import { SyncHistoryView } from "./SyncHistoryView";

/**
 * Slice-4 + Slice-7 Settings overlay. Exposes Import/Export (slice 4) and
 * Sync (slice 7) as first-class user actions.
 *
 * Sync flow:
 *   1. User taps "Sync now"
 *   2. If no SettingsAdapter, show a dialog to paste/import a remote Snapshot
 *   3. Run the merge via the store's sync() action
 *   4. Show feedback toast (conflict or clean merge)
 */

interface SettingsViewProps {
  onClose: () => void;
}

interface Feedback {
  variant: "success" | "error";
  text: string;
}

function resolveSettingsAdapter(): SettingsAdapter | undefined {
  return typeof window === "undefined" ? undefined : window.cookietodoSettingsAdapter?.();
}

function resolveStoreAdapter(): StoreAdapter | undefined {
  if (typeof window === "undefined") return undefined;
  return window.cookietodoStoreAdapter?.();
}

export function SettingsView({ onClose }: SettingsViewProps): JSX.Element {
  const { t } = useTranslation();
  const snapshot = useSnapshot();
  const replaceSnapshot = useReplaceSnapshot();
  const storeError = useError();
  const sync = useSync();
  const revertLastMerge = useRevertLastMerge();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const settingsAdapter = resolveSettingsAdapter();
  const storeAdapter = resolveStoreAdapter();

  async function handleExport(): Promise<void> {
    if (!settingsAdapter) return;
    setBusy(true);
    setFeedback(null);
    try {
      const path = await settingsAdapter.exportSnapshot(snapshot);
      if (path === null) {
        setFeedback({ variant: "success", text: t("settings.export-dismissed") });
        return;
      }
      setFeedback({ variant: "success", text: t("settings.export-success", { path }) });
    } catch (err) {
      setFeedback({ variant: "error", text: t("settings.export-failed", { error: String(err) }) });
    } finally {
      setBusy(false);
    }
  }

  async function handleImport(): Promise<void> {
    if (!settingsAdapter) return;
    setBusy(true);
    setFeedback(null);
    try {
      const imported = await settingsAdapter.importSnapshot();
      if (imported === null) {
        setFeedback({ variant: "success", text: t("settings.import-dismissed") });
        return;
      }
      replaceSnapshot(imported);
      setFeedback({ variant: "success", text: t("settings.import-success") });
    } catch (err) {
      setFeedback({ variant: "error", text: t("settings.import-failed", { error: String(err) }) });
    } finally {
      setBusy(false);
    }
  }

  async function handleSyncNow(): Promise<void> {
    if (!settingsAdapter) return;
    setBusy(true);
    setFeedback(null);
    try {
      // Import the remote snapshot (user picks a file from another device)
      const remote = await settingsAdapter.importSnapshot();
      if (remote === null) {
        setFeedback({ variant: "success", text: t("sync.sync-dismissed") });
        return;
      }
      // Run the merge via the store
      const result = await sync(remote);
      if (result.ok) {
        const total = result.mergeResult.report.totalChanges;
        const conflicts = result.conflictCount;
        if (conflicts > 0) {
          setFeedback({
            variant: "success",
            text: t("sync.merge.result.toast", { total, conflicts }),
          });
        } else {
          setFeedback({ variant: "success", text: t("sync.sync-success", { total }) });
        }
      } else {
        setFeedback({
          variant: "error",
          text: t("sync.sync-failed", { error: result.error ?? "Unknown error" }),
        });
      }
    } catch (err) {
      setFeedback({ variant: "error", text: t("sync.sync-failed", { error: String(err) }) });
    } finally {
      setBusy(false);
    }
  }

  async function handleRevertLastMerge(): Promise<void> {
    setBusy(true);
    setFeedback(null);
    try {
      const ok = await revertLastMerge();
      if (ok) {
        setFeedback({ variant: "success", text: t("sync.revert-last-merge-success") });
      } else {
        setFeedback({ variant: "success", text: t("sync.revert-last-merge-empty") });
      }
    } catch (err) {
      setFeedback({
        variant: "error",
        text: t("sync.revert-last-merge-failed", { error: String(err) }),
      });
    } finally {
      setBusy(false);
    }
  }

  function handleHistoryRevert(_entry: HistoryEntry): void {
    void handleRevertLastMerge();
  }

  if (showHistory && storeAdapter) {
    return (
      <SyncHistoryView
        adapter={storeAdapter}
        onClose={() => setShowHistory(false)}
        onRevert={handleHistoryRevert}
      />
    );
  }

  return (
    <div
      className="settings-overlay"
      data-testid="settings-overlay"
      role="dialog"
      aria-modal="true"
    >
      <div className="settings-card">
        <header className="settings-header">
          <h1>{t("settings.title")}</h1>
          <button
            type="button"
            data-testid="settings.close"
            onClick={onClose}
            aria-label={t("settings.close")}
            disabled={busy}
          >
            ×
          </button>
        </header>

        {storeError && (
          <p role="alert" className="settings-store-error" data-testid="settings.store-error">
            {t("settings.store-error", { error: storeError })}
          </p>
        )}

        {feedback && (
          <p
            role={feedback.variant === "error" ? "alert" : "status"}
            data-testid={`settings.feedback.${feedback.variant}`}
            className={`settings-${feedback.variant}`}
          >
            {feedback.text}
          </p>
        )}

        <section className="settings-section">
          <p className="settings-section-heading">{t("settings.snapshot.section")}</p>
          <p className="settings-section-summary">{t("settings.snapshot.summary")}</p>
          <button
            type="button"
            data-testid="settings.export"
            onClick={() => void handleExport()}
            disabled={!settingsAdapter || busy}
            title={!settingsAdapter ? t("settings.requires-shell") : undefined}
          >
            {t("settings.export")}
          </button>
          <button
            type="button"
            data-testid="settings.import"
            onClick={() => void handleImport()}
            disabled={!settingsAdapter || busy}
            title={!settingsAdapter ? t("settings.requires-shell") : undefined}
          >
            {t("settings.import")}
          </button>
          {!settingsAdapter && (
            <p className="settings-shell-missing" data-testid="settings.shell-missing">
              {t("settings.requires-shell")}
            </p>
          )}
        </section>

        <section className="settings-section" data-testid="settings.sync-section">
          <p className="settings-section-heading">{t("sync.section")}</p>
          <p className="settings-section-summary">{t("sync.summary")}</p>
          <button
            type="button"
            data-testid="settings.sync-now"
            onClick={() => void handleSyncNow()}
            disabled={!settingsAdapter || busy}
            title={!settingsAdapter ? t("settings.requires-shell") : undefined}
          >
            {t("sync.sync-now")}
          </button>
          <button
            type="button"
            data-testid="settings.sync-revert"
            onClick={() => void handleRevertLastMerge()}
            disabled={busy}
          >
            {t("sync.revert-last-merge")}
          </button>
          <button
            type="button"
            data-testid="settings.sync-history"
            onClick={() => setShowHistory(true)}
            disabled={busy}
          >
            {t("sync.history.title")}
          </button>
        </section>
      </div>
    </div>
  );
}
