import { useState } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import type { Todo } from "../domain/types";
import { TodoInputSchema, useCreateTodo, useLists, useUpdateTodo } from "../store/hooks";

interface Props {
  todo?: Todo | undefined;
  onClose: () => void;
}

type NotesMode = "edit" | "preview";

function epochToInputValue(ms: number | null): string {
  if (ms === null) return "";
  return new Date(ms).toISOString().slice(0, 16);
}

function inputValueToEpoch(value: string): number | null {
  if (value === "") return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

export function TodoForm({ todo, onClose }: Props): JSX.Element {
  const { t } = useTranslation();
  const createTodo = useCreateTodo();
  const updateTodo = useUpdateTodo();
  const lists = useLists();

  const [title, setTitle] = useState<string>(todo?.title ?? "");
  const [notes, setNotes] = useState<string>(todo?.notes ?? "");
  const [notesMode, setNotesMode] = useState<NotesMode>("edit");
  const [dueAt, setDueAt] = useState<string>(epochToInputValue(todo?.dueAt ?? null));
  const [listIds, setListIds] = useState<string[]>(todo?.listIds ?? []);
  // reminder remains disabled this slice — never set reminderId.
  const [error, setError] = useState<string | null>(null);

  function handleListIdsChange(e: React.ChangeEvent<HTMLSelectElement>): void {
    const next = Array.from(e.target.selectedOptions).map((o) => o.value);
    setListIds(next);
  }

  const reminderDisabled = dueAt === "";

  function handleSubmit(): void {
    const trimmed = title;
    if (trimmed.trim() === "") {
      setError(t("todo.validation-title-required"));
      return;
    }
    if (trimmed.length > 200) {
      setError(t("todo.validation-title-too-long"));
      return;
    }
    const dueEpoch = inputValueToEpoch(dueAt);
    const input = {
      title: trimmed,
      notes,
      listIds,
      completed: todo?.completed ?? false,
      completedAt: todo?.completedAt ?? null,
      dueAt: dueEpoch,
      reminderId: null,
    };
    const parsed = TodoInputSchema.safeParse(input);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "invalid");
      return;
    }
    if (todo) {
      updateTodo(todo.id, {
        title: parsed.data.title,
        notes: parsed.data.notes,
        listIds: parsed.data.listIds,
        dueAt: parsed.data.dueAt,
      });
    } else {
      createTodo(parsed.data);
    }
    onClose();
  }

  return (
    <div className="form-overlay" data-testid="todo-form">
      <h2>{todo ? t("todo.form-title-edit") : t("todo.form-title-create")}</h2>
      <label>
        {t("todo.field-title")}
        <input
          type="text"
          maxLength={200}
          value={title}
          data-testid="todo-form.title"
          onChange={(e) => setTitle(e.target.value)}
        />
        <span className="char-count">{title.length}/200</span>
      </label>
      <label>
        {t("todo.field-notes")}
        <div className="notes-mode">
          <button
            type="button"
            aria-pressed={notesMode === "edit"}
            onClick={() => setNotesMode("edit")}
          >
            {t("todo.field-notes-edit")}
          </button>
          <button
            type="button"
            aria-pressed={notesMode === "preview"}
            onClick={() => setNotesMode("preview")}
          >
            {t("todo.field-notes-preview")}
          </button>
        </div>
        {notesMode === "edit" ? (
          <textarea
            value={notes}
            data-testid="todo-form.notes"
            onChange={(e) => setNotes(e.target.value)}
          />
        ) : (
          <div data-testid="todo-form.notes-preview" className="notes-preview">
            <ReactMarkdown>{notes}</ReactMarkdown>
          </div>
        )}
      </label>
      <label>
        {t("todo.field-due-at")}
        <input
          type="datetime-local"
          value={dueAt}
          data-testid="todo-form.due-at"
          onChange={(e) => setDueAt(e.target.value)}
        />
      </label>
      <label>
        {t("todo.field-list-ids")}
        <select
          multiple
          value={listIds}
          data-testid="todo-form.list-ids"
          onChange={handleListIdsChange}
        >
          {lists.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("todo.field-reminder")}
        <input
          type="checkbox"
          checked={false}
          disabled={reminderDisabled}
          data-testid="todo-form.reminder-toggle"
          onChange={() => {
            /* reminder disabled slice 3 */
          }}
        />
        {reminderDisabled ? (
          <span className="helper-text">{t("todo.field-reminder-disabled-no-due")}</span>
        ) : (
          <span className="helper-text">{t("todo.field-reminder-not-available")}</span>
        )}
      </label>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="button" data-testid="todo-form.cancel" onClick={onClose}>
          {t("todo.action-cancel")}
        </button>
        <button type="button" data-testid="todo-form.save" onClick={handleSubmit}>
          {t("todo.action-save")}
        </button>
      </div>
    </div>
  );
}
