import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { StoreAdapter } from "../persistence/StoreAdapter";
import type { HistoryEntry } from "../sync/history";

interface SyncHistoryViewProps {
  adapter: StoreAdapter;
  onClose: () => void;
  onRevert: (entry: HistoryEntry) => void;
}

export function SyncHistoryView({ adapter, onClose, onRevert }: SyncHistoryViewProps): JSX.Element {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedEntry, setExpandedEntry] = useState<string | null>(null);
  const [expandedEntity, setExpandedEntity] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { readHistory } = await import("../sync/history");
        const history = await readHistory(adapter);
        if (!cancelled) {
          setEntries(history);
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [adapter]);

  const handleRevert = (entry: HistoryEntry): void => {
    onRevert(entry);
  };

  return (
    <div
      className="sync-history-overlay"
      data-testid="sync-history-overlay"
      role="dialog"
      aria-modal="true"
    >
      <div className="sync-history-card">
        <header className="sync-history-header">
          <h1>{t("sync.history.title")}</h1>
          <button
            type="button"
            data-testid="sync-history.close"
            onClick={onClose}
            aria-label={t("sync.history.close")}
          >
            ×
          </button>
        </header>

        {loading && <p className="sync-history-loading">{t("home.loading")}</p>}

        {!loading && entries.length === 0 && (
          <p className="sync-history-empty" data-testid="sync-history-empty">
            {t("sync.history.empty")}
          </p>
        )}

        {!loading && entries.length > 0 && (
          <ul className="sync-history-list" data-testid="sync-history-list">
            {entries.map((entry, idx) => {
              const entryId = `${entry.timestamp}-${idx}`;
              const isExpanded = expandedEntry === entryId;
              return (
                <li key={entryId} className="sync-history-entry">
                  <button
                    type="button"
                    className="sync-history-entry-header"
                    onClick={() => setExpandedEntry(isExpanded ? null : entryId)}
                    data-testid={`sync-history.entry.${idx}`}
                  >
                    <span className="sync-history-entry-time">
                      {new Date(entry.timestamp).toLocaleString()}
                    </span>
                    <span className="sync-history-entry-summary">
                      {entry.conflictCount > 0
                        ? t("sync.history.conflicts", { count: entry.conflictCount })
                        : t("sync.history.changes", { count: entry.totalChanges })}
                    </span>
                  </button>

                  {isExpanded && (
                    <div
                      className="sync-history-entry-detail"
                      data-testid={`sync-history.entry.${idx}.detail`}
                    >
                      <div className="sync-history-entry-meta">
                        <p>{t("sync.history.conflicts", { count: entry.conflictCount })}</p>
                        <p>{t("sync.history.changes", { count: entry.totalChanges })}</p>
                      </div>

                      {Object.keys(entry.perEntityDiffs).length > 0 && (
                        <div className="sync-history-entities">
                          {Object.entries(entry.perEntityDiffs).map(([entityId, diff]) => {
                            const isEntityExpanded = expandedEntity === entityId;
                            const kindLabel = t(`sync.history.entity-kind-${diff.kind}`);
                            return (
                              <div key={entityId} className="sync-history-entity">
                                <button
                                  type="button"
                                  className="sync-history-entity-header"
                                  onClick={() =>
                                    setExpandedEntity(isEntityExpanded ? null : entityId)
                                  }
                                >
                                  {kindLabel}: {entityId.slice(0, 8)}...
                                </button>
                                {isEntityExpanded && (
                                  <table className="sync-history-field-table">
                                    <thead>
                                      <tr>
                                        <th>{t("sync.history.field")}</th>
                                        <th>{t("sync.history.ancestor")}</th>
                                        <th>{t("sync.history.local")}</th>
                                        <th>{t("sync.history.remote")}</th>
                                        <th>{t("sync.history.merged")}</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {Object.entries(diff.fields).map(([fieldName, outcome]) => (
                                        <tr
                                          key={fieldName}
                                          className={outcome.conflict ? "conflict-row" : ""}
                                        >
                                          <td>{fieldName}</td>
                                          <td>{String(outcome.ancestor ?? "")}</td>
                                          <td>{String(outcome.local ?? "")}</td>
                                          <td>{String(outcome.remote ?? "")}</td>
                                          <td>{String(outcome.merged ?? "")}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}

                      <button
                        type="button"
                        className="sync-history-revert-btn"
                        data-testid={`sync-history.entry.${idx}.revert`}
                        onClick={() => handleRevert(entry)}
                      >
                        {t("sync.history.revert")}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
