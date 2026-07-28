# ADR 0004: Sync is on-launch + interval-driven, with versioned 3-way field-level merge

**Date**: 2026-07-28
**Status**: Accepted

## Context

ADR 0001 established `Snapshot` as JSON (JSONC-tolerant on Import) and explicitly named Sync as the unit that crosses the Sync channel. ADR 0002 disentangled Sync from the Alarm Event path (alarm is per-OS-native, never travels Sync). ADR 0003 locked per-device Store as the authority, with Sync as a best-effort overlay. Q7 of the 2026-07-28 grilling session closes two gaps:

1. *When* does Sync fire on each device?
2. *How* are divergent Snapshots from multiple devices reconciled into one?

The two are coupled — design 1 cannot be evaluated without knowing which conflict resolution design 2 promises.

## Decision A — When Sync fires (mode B from Q7)

- **On app launch**, a Sync pass runs once.
- **At a configurable interval** (v1 default: 5 minutes; user-settable in Settings), a Sync pass runs.
- **Manual `Sync now` button** remains in Settings — explicit user override is permitted so the user can force immediate reconciliation when they remember to.
- **On network-loss**, the interval timer is suspended; on reconnect, a Sync pass fires immediately and the interval timer resumes.
- **No real-time / per-mutation Sync path**. The Store does not observe its own mutations to fan out; reactivity is bounded to the timer.

### Rationale

- Mode A (pure manual) puts "I added the todo on Android and don't see it on Windows" on the user's mental burden of remembering to sync — a known UX failure mode for personal sync apps.
- Mode C (real-time, per-mutation) demands object-level CRDTs, mutation queues, and offline replay, with ROI only at collaborative multi-user scale. Personal 3-device scenarios do not realise the value that justifies the cost.
- Mode B's interval pass can be batched in one 3-way merge (see Decision B), keeping the conflict-coordinate complexity fixed regardless of how dirty either Store became in between.

## Decision B — Conflict resolution: versioned 3-way field-level merge

Each Snapshot carries:

- `commonAncestor: Snapshot | null` — the last-known-synchronized state, persisted at the completion of the previous Sync pass (one JSONL append per local mutator epoch in `snapshot.history.jsonl`).
- Every `Todo`, `List`, and `Reminder` entity carries `id`, `revision: number`, and `updatedAt: number` (epoch ms).

The merge algorithm on each Sync pass:

1. Pull the remote Snapshot (transport out of scope for this ADR — a separate question in the grilling).
2. Identify inserted / updated / deleted entities by `id` in local vs remote vs commonAncestor.
3. For each affected entity:
   - **Inserted on only one side**: import verbatim.
   - **Updated on only one side (other = unchanged vs ancestor)**: take the updated version.
   - **Updated on both sides** — perform field-level 3-way merge using commonAncestor as the base, LWW per field on `updatedAt`; concurrent field-level changes both "win" if they touch disjoint fields; if they touch the same field, LWW on `updatedAt` resolves and the losing field's prior value is recoverable via one-step undo (covered in a future ADR if requested).
   - **Deleted on one side, unchanged on the other**: delete.
   - **Deleted on one side, modified on the other**: prefer the modification (v1 conservative — modification wins over deletion; user can re-delete). The `updatedAt` of the modification must strictly exceed `updatedAt` of the commonAncestor's last-known-delete-trigger timestamp if we go deletion-wins; v1 picks modify-wins to avoid silent loss of edits and surfaces a "this was deleted on another device" chip instead.
4. Tombstones: deleted entities move to `deleted: Entity[]` with `deletedAt` timestamp, retained for `30 days`, then GC'd. Tombstones travel Sync to prevent the zombie-revival problem.
5. Result merged Snapshot replaces both local and remote; commonAncestor advanced to the merged result; transaction persists atomically (write to `snapshot.json.tmp`, fsync, rename per ADR 0003).
6. If the user is undoing / editing mid-Sync, the present Sync pass is aborted and rescheduled; the Store's mutation operations take a session-scoped lock against Sync's write phase.

### Why field-level 3-way and not LWW or CRDT?

- **LWW (last-write-wins, whole object replacement) is rejected** for the canonical scenario: user A edits a todo title on Windows while user B edits notes on the same todo on Android. The Edit-Two-Disjoint-Fields case is the highest-frequency collision in a personal todo tool; LWW silently drops one edit, and "App silently lost my edit" destroys the trust the user handed the app when they put their todos in it. Field-level merge lets both edits win.
- **CRDT is rejected** for v1 because the family of CRDTs required (ORSet for List membership, LWW-Register per scalar field, LWWMap for note content, tombstones + GC) is over-engineering for a 3-device personal tool whose actual conflict hit-rate is near zero. The marginal benefit (zero-conflict math guarantee) does not justify the implementation surface at v1.
- **3-way merge baseline** is what established todo tools ship (Todoist, TickTrack both settled on this shape). It requires per-device retention of the common ancestor (the `snapshot.history.jsonl` line) and that's the local cost.

### Tombstone lifetime and how deletion travels

- Deletion is represented as a tombstone in every Store's `deleted[]`; the tombstone travels across Sync. A device that didn't see the deletion absorbs it. After 30 days of `deletedAt`, the tombstone is GC'd from every Store at the next Sync where all devices confirm they have it (a `tombstoneAcknowledged[deviceId]` map stored on each tombstone).
- The "modify-wins over delete" choice (decision B step 3) differs from Todoist's "delete-wins" — Todoist's choice destroys work if a remote device was mid-edit. Modify-wins is the conservative personal-data choice; a Settings toggle `delete-wins`: defaults false in v1.

## Consequences

- Every Store mutation must `revision++` and `updatedAt = now` on the entity touched.
- The Store must retain one prior common-ancestor Snapshot line on disk in `snapshot.history.jsonl` (A3 warrants atomic writes per ADR 0003; the JSONL append follows the same temp+fsync+rename rule on desktop and the equivalent via `Filesystem.appendFile` on Android).
- A session-scoped lock protects the write phase of each Sync pass against concurrent local mutations — a mutation landing mid-merge queues for the next pass.
- The Sync transport itself (how the two Snapshots meet) is **out of scope for this ADR** and is the next grilling question.
- Out of scope: automated undo beyond one-step (revert last merge). A future ADR reserved for "Sync history viewer / rollback" if v1 users report merge results they regret.
- Out of scope: per-field CRDT upgrade path (no Map-of-LWW-Registers model in Store types). A pre-CRDT upgrade (LWWMap on note content) is reserved for a future ADR if the modify-wins-over-delete default generates user complaints.
- Out of scope: multi-master with N > 2 devices is supported implicitly by the per-id merge rule but the transport is star-shaped (one remote meeting many) in v1 (next ADR will confirm).
