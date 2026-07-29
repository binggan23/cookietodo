import { expect, it } from "vitest";

/**
 * Slice-1 sanity: confirms the Vitest runner launches and exits 0.
 * Real app-domain tests arrive in later slices (`snapshot/`, `sync/merge.ts`,
 * `domain/` Zod round-trips per PRD-0001 "Modules left to lower-fidelity tests").
 */
it("vitest runs", () => {
  expect(1 + 1).toBe(2);
});
