import { useTranslation } from "react-i18next";
import type { List, Todo, Tombstone } from "../domain/types";
import { useDeleted } from "../store/hooks";

/**
 * Recently-deleted items view (slice-3). Renders tombstones from the Store
 * snapshot, newest first.
 *
 * Restore/Purge action wiring deferred to slice 7 (GC) — the buttons are
 * rendered so the Wave 5 e2e selectors exist, but onClick is a no-op this
 * slice. The Wave 5 spec only asserts a tombstone appears after delete +
 * survives relaunch; restore/purge are not exercised. See task brief.
 */
export function DeletedView(): JSX.Element {
  const { t } = useTranslation();
  const tombstones = useDeleted();
  const sorted = [...tombstones].sort((a, b) => b.deletedAt - a.deletedAt);

  return (
    <section data-testid="recently-deleted" className="recently-deleted">
      <h2>{t("deleted.heading")}</h2>
      {sorted.length === 0 ? (
        <p>{t("deleted.empty")}</p>
      ) : (
        <ul>
          {sorted.map((ts) => {
            const title = tombstoneLabel(ts);
            const kindKey =
              ts.kind === "todo" ? "deleted.item-kind-todo" : "deleted.item-kind-list";
            return (
              <li key={ts.id} data-testid={`tombstone.${ts.id}`}>
                <span className="tombstone-title">{title}</span>
                <span className="tombstone-kind">{t(kindKey)}</span>
                <span className="tombstone-deleted-at">
                  {t("deleted.item-deleted-at", { time: new Date(ts.deletedAt).toLocaleString() })}
                </span>
                {/* Restore/Purge action wiring deferred to slice 7 (GC). */}
                <button
                  type="button"
                  data-testid={`tombstone.${ts.id}.restore`}
                  onClick={() => {
                    /* no-op slice 3 */
                  }}
                >
                  {t("deleted.action-restore")}
                </button>
                <button
                  type="button"
                  data-testid={`tombstone.${ts.id}.purge`}
                  onClick={() => {
                    /* no-op slice 3 */
                  }}
                >
                  {t("deleted.action-purge")}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function tombstoneLabel(ts: Tombstone): string {
  if (ts.kind === "todo") {
    const todo = ts.snapshot as Todo;
    return todo.title;
  }
  const list = ts.snapshot as List;
  return list.name;
}
