import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { SettingsAdapter } from "../settings/SettingsAdapter";
import { useError, useReplaceSnapshot, useSnapshot } from "../store/hooks";

/**
 * Slice-4 Settings overlay (ADR 0001 + ADR 0003). Exposes Import/Export as
 * first-class user actions backed by native OS dialogs (`dialog.showSaveDialog`
 * / `dialog.showOpenDialog` on desktop via the preload's
 * `window.cookietodoSettingsAdapter`).
 *
 * Flow:
 *   - Export  → adapter.exportSnapshot(snapshot) → main serializes +
 *     showSaveDialog + writeFile. Surfaces the absolute path written on
 *     success (Sub-AC: "verify the file exists and is valid JSON").
 *   - Import  → adapter.importSnapshot() → main opens picker, reads file,
 *     parses JSONC + Zod-validates, returns Snapshot. Renderer calls
 *     `replaceSnapshot(snapshot)` (Store persists atomically via
 *     `saveSnapshot`). On `null` (dismissed) no mutation.
 *
 * When no preload is present (Vitest, headless Vite preview): the Settings
 * buttons render DISABLED with a tooltip explaining Import/Export require the
 * Electron shell — mirrors the slice-3 fallback convention absent shell =
 * soft-fail, never a crash.
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

export function SettingsView({ onClose }: SettingsViewProps): JSX.Element {
  const { t } = useTranslation();
  const snapshot = useSnapshot();
  const replaceSnapshot = useReplaceSnapshot();
  const storeError = useError();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const adapter = resolveSettingsAdapter();

  async function handleExport(): Promise<void> {
    if (!adapter) return;
    setBusy(true);
    setFeedback(null);
    try {
      const path = await adapter.exportSnapshot(snapshot);
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
    if (!adapter) return;
    setBusy(true);
    setFeedback(null);
    try {
      const imported = await adapter.importSnapshot();
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
            disabled={!adapter || busy}
            title={!adapter ? t("settings.requires-shell") : undefined}
          >
            {t("settings.export")}
          </button>
          <button
            type="button"
            data-testid="settings.import"
            onClick={() => void handleImport()}
            disabled={!adapter || busy}
            title={!adapter ? t("settings.requires-shell") : undefined}
          >
            {t("settings.import")}
          </button>
          {!adapter && (
            <p className="settings-shell-missing" data-testid="settings.shell-missing">
              {t("settings.requires-shell")}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
