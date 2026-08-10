import { useState } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import { ulid } from "ulid";
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
  // Slice 5: reminder toggle is LIVE — defaults to the Todo's existing
  // reminder state; disabled while dueAt is null (AC #1: reminder field
  // greyed out / disabled when dueAt is null). `!= null` (loose) so a brand
  // new Todo (todo === undefined) resolves to false, NOT true — a strict
  // `!== null` on undefined yields true and would arm the reminder by default.
  const [reminderOn, setReminderOn] = useState<boolean>(todo?.reminderId != null);
  // `triggerAt` defaults to the Todo's `dueAt` in the editor UI (AC #4); the
  // user may override it separately ("remind me 5 minutes before due").
  const [triggerAt, setTriggerAt] = useState<string>(epochToInputValue(todo?.dueAt ?? null));
  // Hand-completion (AC #8 / ADR 0007): the in-form "completed" checkbox is
  // the offline equivalent of password-dismiss — completing clears the fired
  // Reminder in the store (T3), so no extra logic is needed here.
  const [completed, setCompleted] = useState<boolean>(todo?.completed ?? false);
  const [error, setError] = useState<string | null>(null);

  function handleListIdsChange(e: React.ChangeEvent<HTMLSelectElement>): void {
    const next = Array.from(e.target.selectedOptions).map((o) => o.value);
    setListIds(next);
  }

  const reminderDisabled = dueAt === "";

  function handleReminderToggle(): void {
    if (reminderDisabled) return;
    const next = !reminderOn;
    setReminderOn(next);
    // When the user first turns the reminder on, default triggerAt to the
    // current dueAt input value (AC #4 — the default; the user can then
    // override the triggerAt field separately).
    if (next && triggerAt === "") {
      setTriggerAt(dueAt);
    }
    if (!next) {
      setTriggerAt("");
    }
  }

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
    // reminderTriggerAt: only when the reminder is on AND a due time exists.
    // The store's TodoInputSchema.superRefine rejects orphan combos.
    const reminderActive = reminderOn && dueEpoch !== null;
    const triggerEpoch = reminderActive ? inputValueToEpoch(triggerAt) : null;
    if (reminderActive && triggerEpoch === null) {
      setError(t("todo.validation-reminder-needs-due"));
      return;
    }
    // completedAt transition: preserved when an already-completed Todo is
    // saved unchanged, stamped now on a false→true flip, null on un-complete.
    const completedAt = completed
      ? todo?.completed
        ? (todo.completedAt ?? Date.now())
        : Date.now()
      : null;
    const input = {
      title: trimmed,
      notes,
      listIds,
      completed,
      completedAt,
      dueAt: dueEpoch,
      reminderId: reminderActive ? (todo?.reminderId ?? (ulid() as Todo["id"])) : null,
      reminderTriggerAt: reminderActive ? triggerEpoch : null,
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
        completed: parsed.data.completed,
        completedAt: parsed.data.completedAt,
        reminderId: parsed.data.reminderId,
        reminderTriggerAt: parsed.data.reminderTriggerAt,
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
        {t("todo.field-completed")}
        <input
          type="checkbox"
          checked={completed}
          data-testid="todo-form.completed"
          onChange={(e) => setCompleted(e.target.checked)}
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
          checked={reminderOn}
          disabled={reminderDisabled}
          data-testid="todo-form.reminder-toggle"
          onChange={handleReminderToggle}
        />
        {reminderDisabled ? (
          <span className="helper-text">{t("todo.field-reminder-disabled-no-due")}</span>
        ) : (
          <span className="helper-text">{t("todo.field-reminder-on")}</span>
        )}
      </label>
      {reminderOn && !reminderDisabled && (
        <label>
          {t("todo.field-reminder-trigger-at")}
          <input
            type="datetime-local"
            value={triggerAt}
            data-testid="todo-form.reminder-trigger-at"
            onChange={(e) => setTriggerAt(e.target.value)}
          />
          <span className="helper-text">{t("todo.field-reminder-trigger-offset-hint")}</span>
        </label>
      )}
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
