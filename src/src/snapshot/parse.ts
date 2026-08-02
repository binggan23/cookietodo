/**
 * JSONC-tolerant Snapshot parser (ADR 0001 Import side).
 *
 * `parseSnapshot(text)` accepts:
 *   - strict JSON (per ADR 0001 Export side, written by {@link ./serialize.ts}),
 *   - JSONC — line comments `//`, block comments `/* … *​/`, trailing commas —
 *     so a user who hand-edits an export does not break the round-trip
 *     (ADR 0001 Rationale: "JSONC tolerance covers the human-edit case").
 *
 * Pipeline:
 *   1. `jsonc-parser.parse(text, errors, opts)` — fault-tolerant parse.
 *      Fault-tolerance is the lib's contract: it NEVER throws; pass the
 *      `errors` out-param and fail closed on any non-empty `errors[]`.
 *      Hard-reject anything `JSON.parse` would have refused — the `errors[]`
 *      surface is the bar (ADR 0001 consequence: "Import parser must accept
 *      JSONC; reject nothing that `JSON.parse` would have produced" — i.e.
 *      reject what `JSON.parse` would NOT have produced).
 *   2. `SnapshotSchema.parse(raw)` — Zod 4 validation with forward/back-compat:
 *        - missing fields default via `.default(...)` (back-compat per ADR 0001),
 *        - unknown top-level keys preserved via `.catchall(z.unknown())`
 *          (forward-compat per ADR 0001 — re-exported unchanged).
 *        - `schemaVersion` is a Zod `z.literal(1)`: any other value rejections
 *          throw with a clear "unsupported snapshot version" message (the
 *          migration anchor intentionally strict — a future schemaVersion 2
 *          must go through a migration slice, NOT silently load).
 *
 * PUBLIC SURFACE: `@cookietodo/renderer/snapshot/parse`
 * (see `../../package.json` `exports` map entry).
 */
import { type ParseErrorCode, type ParseOptions, parse } from "jsonc-parser";
import { type Snapshot, SnapshotSchema } from "../domain/types";

/** JSONC parse options — comments + trailing commas allowed (ADR 0001 Import). */
const PARSE_OPTS: ParseOptions = {
  disallowComments: false,
  allowTrailingComma: true,
  allowEmptyContent: false,
};

/**
 * Parse a Snapshot file body (strict JSON or JSONC) into a validated
 * {@link Snapshot}. Throws a {@link SnapshotParseError} on malformed JSONC
 * input, or a `z.ZodError` on schema-validation failure — the caller (UI /
 * IPC handler) is responsible for surfacing either to the user as a clear
 * error without mutating the in-memory Store (ADR 0008 failure-mode UX).
 *
 * @throws {SnapshotParseError} when `jsonc-parser` reports scan/parse errors.
 * @throws {import("zod").ZodError} when the parsed object fails Zod validation.
 */
export function parseSnapshot(text: string): Snapshot {
  const errors: { error: ParseErrorCode; offset: number; length: number }[] = [];
  const raw: unknown = parse(text, errors, PARSE_OPTS);
  if (errors.length > 0) {
    throw new SnapshotParseError(errors);
  }
  if (raw === undefined) {
    throw new SnapshotParseError([{ error: 0 as ParseErrorCode, offset: 0, length: text.length }]);
  }
  return SnapshotSchema.parse(raw);
}

/**
 * Error thrown when `jsonc-parser` reports scan/parse errors. Carries the
 * `{ error, offset, length }` triplets verbatim so a caller can render a
 * precise caret line for the offending bytes.
 *
 * Named so a caller can `instanceof`-check it to distinguish parse-syntax
 * failure (this) from Zod-schema-validation failure (`z.ZodError`).
 *
 * `ParseErrorCode` is a const-enum in the upstream lib — incompatible with
 * `verbatimModuleSyntax`, so we surface raw numeric `error` codes here and
 * let the caller stringify if needed (the UI shows the `message` which
 * already lists numeric codes; a future i18n slice can name them).
 */
export class SnapshotParseError extends Error {
  readonly errors: ReadonlyArray<{ error: ParseErrorCode; offset: number; length: number }>;
  constructor(errors: ReadonlyArray<{ error: ParseErrorCode; offset: number; length: number }>) {
    super(
      `Snapshot JSONC parse failed: ${errors
        .map((e) => `code=${e.error}@${e.offset}+${e.length}`)
        .join(", ")}`,
    );
    this.name = "SnapshotParseError";
    this.errors = errors;
  }
}

export type { ParseErrorCode, ParseOptions } from "jsonc-parser";
