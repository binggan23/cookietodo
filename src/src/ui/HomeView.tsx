import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { List, Reminder, Todo } from "../domain/types";
import {
  useClearRebootBanner,
  useDeleted,
  useDeleteList,
  useDeleteTodo,
  useLists,
  useLoad,
  useLoaded,
  useReminders,
  useTodos,
  useToggleCompleted,
} from "../store/hooks";
import { DeletedView } from "./DeletedView";
import { ListForm } from "./ListForm";
import { SettingsView } from "./SettingsView";
import { TodoForm } from "./TodoForm";

type Mode = "flat" | "grouped";
type OverlayForm = "todo" | "list" | "settings" | null;

export function HomeView(): JSX.Element {
  const { t } = useTranslation();
  const todos = useTodos();
  const lists = useLists();
  const deleted = useDeleted();
  const loaded = useLoaded();
  const load = useLoad();
  const deleteTodo = useDeleteTodo();
  const toggleCompleted = useToggleCompleted();
  const reminders = useReminders();
  const clearRebootBanner = useClearRebootBanner();

  const [mode, setMode] = useState<Mode>("flat");
  const [form, setForm] = useState<OverlayForm>(null);
  const [editingTodo, setEditingTodo] = useState<Todo | null>(null);
  const [editingList, setEditingList] = useState<List | null>(null);

  useEffect(() => {
    if (!loaded) {
      void load();
    }
  }, [load, loaded]);

  const showLoading = !loaded && todos.length === 0;

  // Post-reboot alarm-bypass banners (AC #8): surface every escaped Reminder —
  // either `fired` (alarm rang before reboot, never dismissed/snoozed) OR
  // `pending` with a past-due `triggerAt` (alarm armed for a moment in the
  // past the scheduler never got to fire before shutdown) — gated on
  // `pendingPostRebootBanner` and joined to its Todo. The matcher shape
  // mirrors the canonical `markRebootEscapes` pure fn in
  // `src/persistence/markRebootEscapes.ts` (the renderer-side copy this
  // banner reads) so the banner the user sees is exactly the set the trigger
  // flagged (drift-guard contract).
  const now = Date.now();
  const pendingBypass = reminders
    .filter(
      (r) =>
        r.pendingPostRebootBanner &&
        (r.state === "fired" || (r.state === "pending" && r.triggerAt <= now)),
    )
    .map((r) => ({ reminder: r, todo: todos.find((t) => t.id === r.todoId) }))
    .filter((x): x is { reminder: Reminder; todo: Todo } => x.todo !== undefined);

  const openTodoDetail = (todo: Todo): void => {
    setEditingTodo(todo);
    setForm("todo");
  };

  return (
    <div className="home-view">
      {pendingBypass.length > 0 && (
        <div className="alarm-bypass-banners">
          {pendingBypass.map(({ reminder, todo }) => (
            <div
              key={reminder.id}
              className="alarm-bypass-banner"
              data-testid={`alarm-bypass-banner.${todo.title}`}
            >
              <button
                type="button"
                data-testid="alarm-bypass.banner.open"
                onClick={() => openTodoDetail(todo)}
              >
                {t("alarm.bypass.banner", { title: todo.title })}
              </button>
              <button
                type="button"
                data-testid="alarm-bypass.banner.dismiss"
                onClick={() => clearRebootBanner(reminder.id)}
              >
                {t("alarm.bypass.dismiss")}
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="home-toolbar">
        <button
          type="button"
          data-testid="home.toggle-group"
          onClick={() => setMode((m) => (m === "flat" ? "grouped" : "flat"))}
        >
          {mode === "flat" ? t("home.toggle-grouped") : t("home.toggle-flat")}
        </button>
        <button
          type="button"
          data-testid="home.create-todo"
          onClick={() => {
            setEditingTodo(null);
            setForm("todo");
          }}
        >
          {t("home.create-todo")}
        </button>
        <button type="button" data-testid="home.create-list" onClick={() => setForm("list")}>
          {t("home.create-list")}
        </button>
        <button
          type="button"
          data-testid="home.open-settings"
          onClick={() => setForm("settings")}
          aria-label={t("settings.open")}
        >
          ⚙
        </button>
      </div>

      {showLoading && <p>{t("home.loading")}</p>}

      {!showLoading && todos.length === 0 && lists.length === 0 && deleted.length === 0 ? (
        <p>{t("home.empty")}</p>
      ) : (
        <div className="home-body">
          {lists.length > 0 && (
            <ListSummary
              lists={lists}
              onEdit={(list) => {
                setEditingList(list);
                setForm("list");
              }}
            />
          )}
          {showLoading ? null : mode === "flat" ? (
            <TodoList todos={todos} onToggle={toggleCompleted} onDelete={deleteTodo} />
          ) : (
            <GroupedTodoList
              todos={todos}
              lists={lists}
              onToggle={toggleCompleted}
              onDelete={deleteTodo}
            />
          )}
        </div>
      )}

      <DeletedView />

      {form === "todo" && (
        <TodoForm
          todo={editingTodo ?? undefined}
          onClose={() => {
            setForm(null);
            setEditingTodo(null);
          }}
        />
      )}
      {form === "list" && (
        <ListForm
          list={editingList ?? undefined}
          onClose={() => {
            setForm(null);
            setEditingList(null);
          }}
        />
      )}
      {form === "settings" && <SettingsView onClose={() => setForm(null)} />}
    </div>
  );
}

interface ListSummaryProps {
  lists: List[];
  onEdit: (list: List) => void;
}

function ListSummary({ lists, onEdit }: ListSummaryProps): JSX.Element {
  const { t } = useTranslation();
  const deleteList = useDeleteList();

  const handleDelete = (list: List): void => {
    if (window.confirm(t("list.confirm-delete", { name: list.name }))) {
      deleteList(list.id);
    }
  };

  return (
    <ul className="list-summary" aria-label="Lists">
      {lists.map((list) => (
        <li key={list.id} style={list.color ? { color: list.color } : undefined}>
          {list.name}
          <button type="button" onClick={() => onEdit(list)}>
            {t("list.action-edit")}
          </button>
          <button type="button" onClick={() => handleDelete(list)}>
            {t("list.action-delete")}
          </button>
        </li>
      ))}
    </ul>
  );
}

interface TodoListProps {
  todos: Todo[];
  onToggle: (id: Todo["id"]) => void;
  onDelete: (id: Todo["id"]) => void;
}

function TodoList({ todos, onToggle, onDelete }: TodoListProps): JSX.Element {
  return (
    <ul className="todo-list">
      {todos.map((todo) => (
        <TodoRow key={todo.id} todo={todo} onToggle={onToggle} onDelete={onDelete} />
      ))}
    </ul>
  );
}

interface GroupedTodoListProps extends TodoListProps {
  lists: List[];
}

function GroupedTodoList({ todos, lists, onToggle, onDelete }: GroupedTodoListProps): JSX.Element {
  const { t } = useTranslation();
  const noListTodos = todos.filter((t) => t.listIds.length === 0);
  return (
    <div className="todo-grouped">
      {lists.map((list) => {
        const bucket = todos.filter((t) => t.listIds.includes(list.id));
        if (bucket.length === 0) return null;
        return (
          <section key={list.id} className="todo-group">
            <h3 style={list.color ? { color: list.color } : undefined}>{list.name}</h3>
            <ul className="todo-list">
              {bucket.map((todo) => (
                <TodoRow key={todo.id} todo={todo} onToggle={onToggle} onDelete={onDelete} />
              ))}
            </ul>
          </section>
        );
      })}
      {noListTodos.length > 0 && (
        <section className="todo-group">
          <h3>{t("list.color-default")}</h3>
          <ul className="todo-list">
            {noListTodos.map((todo) => (
              <TodoRow key={todo.id} todo={todo} onToggle={onToggle} onDelete={onDelete} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

interface TodoRowProps {
  todo: Todo;
  onToggle: (id: Todo["id"]) => void;
  onDelete: (id: Todo["id"]) => void;
}

function TodoRow({ todo, onToggle, onDelete }: TodoRowProps): JSX.Element {
  const { t } = useTranslation();
  const safeTitle = todo.title;
  const dueAt = todo.dueAt !== null ? new Date(todo.dueAt).toLocaleString() : "";
  return (
    <li className={`todo-row${todo.completed ? " todo-completed" : ""}`}>
      <span data-testid={`todo-item.${safeTitle}.completed`} className="todo-title">
        {todo.title}
      </span>
      {todo.notes && <span className="todo-notes-excerpt">{todo.notes.slice(0, 80)}</span>}
      {dueAt && <span className="todo-due-at">{dueAt}</span>}
      <button
        type="button"
        data-testid={`todo-item.${safeTitle}.complete`}
        onClick={() => onToggle(todo.id)}
      >
        {todo.completed ? t("todo.action-uncomplete") : t("todo.action-complete")}
      </button>
      <button
        type="button"
        data-testid={`todo-item.${safeTitle}.delete`}
        onClick={() => onDelete(todo.id)}
      >
        {t("todo.action-delete")}
      </button>
    </li>
  );
}
