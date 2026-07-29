import { useEffect, useRef } from "react";

/**
 * 6-digit numeric alarm-dismiss password input (ADR 0009 Decision B).
 *
 * Input-layer constraints enforced per PRD-0001 acceptance criterion #3:
 * exactly six slots, each `<input maxLength=1 inputMode="numeric" pattern="[0-9]">`;
 * the layer rejects any non-digit character at the change boundary so a
 * user cannot paste a letter/space and reach 6 visually-filled cells with
 * content the alarm-dismiss flow later rejects.
 *
 * Auto-advance on digit entry + backspace jump-back are standard OS-password
 * UX. Both keyboard and paste are supported at a single-event level. No rate
 * limit, no hint, no hint of partial correctness — the dismiss password UX
 * must not leak side-channel per ADR 0009 Decision B.
 */

interface Props {
  /** Current code shape accepted so far — digits only, length 0..6. */
  value: string;
  /** Fires with the next code state (also digits-only, length 0..6). */
  onChange(next: string): void;
  /** when true the inputs reflect a mismatched confirm attempt — caller
   *  decides own styling; the component's aria-invalid mirrors it. */
  invalid?: boolean;
  /** ARIA label for each slot — visual-only labels are i18next keys set by the
   *  parent (`t("first-launch.password.slot-label", { n: i+1 })`). */
  ariaLabelForSlot?: (i: number) => string;
  /** Reflector for tests — receives a function that focuses slot `i`. */
  focusRef?: (focusAt: (i: number) => void) => void;
}

const SLOT_COUNT = 6;
const SLOT_KEYS = ["pin-0", "pin-1", "pin-2", "pin-3", "pin-4", "pin-5"] as const;

const DIGIT = /^[0-9]$/;

function toSlots(value: string): string[] {
  const padded: string[] = Array.from({ length: SLOT_COUNT }, () => "");
  const stripped = value.replace(/\D/g, "").slice(0, SLOT_COUNT);
  for (let i = 0; i < stripped.length; i += 1) {
    padded[i] = stripped[i] ?? "";
  }
  return padded;
}

export function PasswordInput(props: Props): JSX.Element {
  const { value, onChange, invalid, ariaLabelForSlot, focusRef } = props;
  const slotRefs = useRef<(HTMLInputElement | null)[]>([]);

  function focusAt(i: number): void {
    const sane = Math.max(0, Math.min(SLOT_COUNT - 1, i));
    const el = slotRefs.current[sane] ?? null;
    el?.focus();
    el?.select();
  }

  // one-shot attach: a per-render re-register discards the test harness's captured closure.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional one-shot attach
  useEffect(() => {
    if (focusRef) {
      focusRef(focusAt);
    }
  }, [focusRef]);

  const slots = toSlots(value);

  function handleChange(slotIndex: number, raw: string): void {
    if (raw === "") {
      // backspace handling already done in keydown; treat empty change as no-op
      return;
    }
    if (!DIGIT.test(raw) && raw !== "") {
      // Reject non-digit at the input layer — accept only the last char in case
      // the user pasted "12" while already focused; extract digits and stash.
      const digitsOnly = raw.replace(/\D/g, "");
      if (digitsOnly === "") {
        return;
      }
      applyDigits(slotIndex, digitsOnly.slice(0, SLOT_COUNT - slotIndex));
      return;
    }
    applyDigits(slotIndex, raw.slice(-1));
  }

  function applyDigits(startSlot: number, typed: string): void {
    const next = toSlots(value).slice();
    for (let i = 0; i < typed.length && startSlot + i < SLOT_COUNT; i += 1) {
      next[startSlot + i] = typed[i] ?? "";
    }
    onChange(next.join(""));
    focusAt(Math.min(SLOT_COUNT - 1, startSlot + typed.length));
  }

  function handleKeyDown(slotIndex: number, e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "Backspace") {
      e.preventDefault();
      const next = toSlots(value).slice();
      if (next[slotIndex] !== "") {
        next[slotIndex] = "";
        onChange(next.join(""));
        return;
      }
      if (slotIndex > 0) {
        next[slotIndex - 1] = "";
        onChange(next.join(""));
        focusAt(slotIndex - 1);
      }
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      focusAt(slotIndex - 1);
      return;
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      focusAt(slotIndex + 1);
    }
  }

  function handlePaste(slotIndex: number, e: React.ClipboardEvent<HTMLInputElement>): void {
    e.preventDefault();
    const text = e.clipboardData.getData("text");
    const digits = text.replace(/\D/g, "").slice(0, SLOT_COUNT);
    if (digits === "") {
      return;
    }
    applyDigits(slotIndex, digits);
  }

  return (
    <div className="password-input" data-testid="password-input" data-invalid={invalid ?? "false"}>
      {SLOT_KEYS.map((key, i) => (
        <input
          key={key}
          ref={(el) => {
            slotRefs.current[i] = el;
          }}
          type="text"
          inputMode="numeric"
          pattern="[0-9]"
          maxLength={1}
          value={slots[i] ?? ""}
          aria-label={ariaLabelForSlot ? ariaLabelForSlot(i) : `slot ${i + 1}`}
          aria-invalid={invalid ?? false}
          data-testid={`password-slot-${i}`}
          autoComplete="off"
          onChange={(e) => handleChange(i, e.target.value)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          onPaste={(e) => handlePaste(i, e)}
          onFocus={(e) => e.target.select()}
        />
      ))}
    </div>
  );
}

export { SLOT_COUNT };
