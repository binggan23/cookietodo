import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { List } from "../domain/types";
import { ListInputSchema, useCreateList, useUpdateList } from "../store/hooks";

interface Props {
  list?: List | undefined;
  onClose: () => void;
}

const HEX_COLOR_DEFAULT = "#1a1a1a";

export function ListForm({ list, onClose }: Props): JSX.Element {
  const { t } = useTranslation();
  const createList = useCreateList();
  const updateList = useUpdateList();

  const initialName = list?.name ?? "";
  const initialColor = list?.color ?? HEX_COLOR_DEFAULT;
  const [name, setName] = useState<string>(initialName);
  const [color, setColor] = useState<string | null>(list?.color ?? null);
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(): void {
    if (name.trim() === "") {
      setError(t("list.validation-name-required"));
      return;
    }
    if (name.length > 80) {
      setError(t("list.validation-name-too-long"));
      return;
    }
    const input = { name, color };
    const parsed = ListInputSchema.safeParse(input);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "invalid");
      return;
    }
    if (list) {
      updateList(list.id, { name: parsed.data.name, color: parsed.data.color });
    } else {
      createList(parsed.data);
    }
    onClose();
  }

  return (
    <div className="form-overlay" data-testid="list-form">
      <h2>{list ? t("list.form-title-edit") : t("list.form-title-create")}</h2>
      <label>
        {t("list.field-name")}
        <input
          type="text"
          maxLength={80}
          value={name}
          data-testid="list-form.name"
          onChange={(e) => setName(e.target.value)}
        />
        <span className="char-count">{name.length}/80</span>
      </label>
      <label>
        {t("list.field-color")}
        <input
          type="color"
          value={color ?? initialColor}
          data-testid="list-form.color"
          onChange={(e) => setColor(e.target.value)}
        />
        <button type="button" data-testid="list-form.color-default" onClick={() => setColor(null)}>
          {t("list.color-default")}
        </button>
      </label>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="button" data-testid="list-form.cancel" onClick={onClose}>
          {t("list.action-cancel")}
        </button>
        <button type="button" data-testid="list-form.save" onClick={handleSubmit}>
          {t("list.action-save")}
        </button>
      </div>
    </div>
  );
}
