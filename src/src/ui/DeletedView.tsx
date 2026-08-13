import { useTranslation } from "react-i18next";
import type { List, Todo, Tombstone } from "../domain/types";
import { useDeleted, useReplaceSnapshot } from "../store/hooks";
import { cookietodoStore } from "../store/store";

/**
 * Recently-deleted items view (slice-3). Renders tombstones from the Store
 * snapshot, newest first.
 */
export function DeletedView(): JSX.Element {
  const { t } = useTranslation();
  const tombstones = useDeleted();
  const replaceSnapshot = useReplaceSnapshot();
  const sorted = [...tombstones].sort((a, b) => b.deletedAt - a.deletedAt);

  const handleRestore = (ts: Tombstone): void => {
    const state = cookietodoStore.getState();
    const snapshot = state.snapshot;
    const deleted = snapshot.deleted.filter((d) => d.id !== ts.id);

    if (ts.kind === "todo") {
      const todo = ts.snapshot as Todo;
      replaceSnapshot({
        ...snapshot,
        todos: [...snapshot.todos, todo],
        deleted,
      });
    } else {
      const list = ts.snapshot as List;
      replaceSnapshot({
        ...snapshot,
        lists: [...snapshot.lists, list],
        deleted,
      });
    }
  };

  const handlePurge = (ts: Tombstone): void => {
    const state = cookietodoStore.getState();
    const snapshot = state.snapshot;
    const deleted = snapshot.deleted.filter((d) => d.id !== ts.id);
    replaceSnapshot({
      ...snapshot,
      deleted,
    });
  };

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
                {/* Restore/Purge actions */}
                <button
                  type="button"
                  data-testid={`tombstone.${ts.id}.restore`}
                  onClick={() => {
                    handleRestore(ts);
                  }}
                >
                  {t("deleted.action-restore")}
                </button>
                <button
                  type="button"
                  data-testid={`tombstone.${ts.id}.purge`}
                  onClick={() => {
                    handlePurge(ts);
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
