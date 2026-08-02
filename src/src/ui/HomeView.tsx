import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { List, Todo } from "../domain/types";
import {
  useDeleted,
  useDeleteTodo,
  useLists,
  useLoad,
  useLoaded,
  useTodos,
  useToggleCompleted,
} from "../store/hooks";
import { DeletedView } from "./DeletedView";
import { ListForm } from "./ListForm";
import { TodoForm } from "./TodoForm";

type Mode = "flat" | "grouped";
type OverlayForm = "todo" | "list" | null;

export function HomeView(): JSX.Element {
  const { t } = useTranslation();
  const todos = useTodos();
  const lists = useLists();
  const deleted = useDeleted();
  const loaded = useLoaded();
  const load = useLoad();
  const deleteTodo = useDeleteTodo();
  const toggleCompleted = useToggleCompleted();

  const [mode, setMode] = useState<Mode>("flat");
  const [form, setForm] = useState<OverlayForm>(null);

  useEffect(() => {
    if (!loaded) {
      void load();
    }
  }, [load, loaded]);

  const showLoading = !loaded && todos.length === 0;

  return (
    <div className="home-view">
      <div className="home-toolbar">
        <button
          type="button"
          data-testid="home.toggle-group"
          onClick={() => setMode((m) => (m === "flat" ? "grouped" : "flat"))}
        >
          {mode === "flat" ? t("home.toggle-grouped") : t("home.toggle-flat")}
        </button>
        <button type="button" data-testid="home.create-todo" onClick={() => setForm("todo")}>
          {t("home.create-todo")}
        </button>
        <button type="button" data-testid="home.create-list" onClick={() => setForm("list")}>
          {t("home.create-list")}
        </button>
      </div>

      {showLoading && <p>{t("home.loading")}</p>}

      {!showLoading && todos.length === 0 && lists.length === 0 && deleted.length === 0 ? (
        <p>{t("home.empty")}</p>
      ) : (
        <div className="home-body">
          {lists.length > 0 && <ListSummary lists={lists} />}
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

      {form === "todo" && <TodoForm onClose={() => setForm(null)} />}
      {form === "list" && <ListForm onClose={() => setForm(null)} />}
    </div>
  );
}

interface ListSummaryProps {
  lists: List[];
}

function ListSummary({ lists }: ListSummaryProps): JSX.Element {
  return (
    <ul className="list-summary" aria-label="Lists">
      {lists.map((list) => (
        <li key={list.id} style={list.color ? { color: list.color } : undefined}>
          {list.name}
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
