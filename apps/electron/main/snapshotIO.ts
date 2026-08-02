/**
 * Main-process local Snapshot Import/Export utilities.
 *
 * Why a main-local copy and not an import from `@cookietodo/renderer/snapshot`:
 * the main process runs compiled JS (`tsc -p tsconfig.electron.json` emits
 * `dist-electron/main/*.js`); importing from `@cookietodo/renderer/snapshot/parse`
 * would resolve at runtime to raw `.ts` source paths via the renderer package's
 * `exports` map — Electron's Node ESM loader cannot parse `.ts`, so the import
 * would crash the main process at boot. This mirrors slice-3's
 * {@link ./snapshotSchema.ts} decision: main keeps a local copy of the Zod
 * schema + JSONC parser because the renderer package's `.ts` raw source isn't
 * loadable from main-runtime.
 *
 * Drift guard: keep this in lockstep with renderer's
 * `src/snapshot/parse.ts` + `src/snapshot/serialize.ts`. The Zod schema shape
 * is shared via {@link ./snapshotSchema} (already lockstep with
 * `src/domain/schemas.ts` per slice-3 drift guard).
 */
import { type ParseErrorCode, type ParseOptions, parse } from "jsonc-parser";
import { type Snapshot, SnapshotSchema } from "./snapshotSchema.js";

const PARSE_OPTS: ParseOptions = {
  disallowComments: false,
  allowTrailingComma: true,
  allowEmptyContent: false,
};

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

export function serializeSnapshot(snapshot: Snapshot): string {
  const validated = SnapshotSchema.parse(snapshot);
  return JSON.stringify(validated, null, 2);
}

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
