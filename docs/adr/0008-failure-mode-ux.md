# ADR 0008: Failure-mode UX — Sync errors, lock contention, missing permissions, merge outcome notifications

**Date**: 2026-07-28
**Status**: Accepted

## Context

ADR 0004 / 0005 / 0006 / 0007 collectively defined the happy paths of Sync, merge, alarm and dismissal. The cross-cutting question left open is the user-facing surface for the unhappy paths: what does the app say and do when one of these flows breaks? Q9 of the 2026-07-28 grilling (item #6) decided the user-facing protocol; user instruction explicitly accepted the recommended default.

## Decision A — WebDAV connection failure (credentials, network, 5xx)

No popup, no toast. The Settings page renders a status row "上次同步：失败" with a timestamp; tapping the row opens a details panel showing the underlying cause (auth, network, transport, server-err) and a "立即重试" button. The Sync interval timer auto-resumes on the next tick after the failure (does not require user action).

If the user is offline and has been for >2 Sync intervals, Settings surfaces a one-line subtitle: "App 处于离线状态，同步已暂停，恢复网络后将自动继续".

## Decision B — WebDAV LOCK contention

When the app's Sync pass fails to acquire the remote LOCK (another device is mid-merge):

- Thecancelled pass silently backs off 5s × 3 times.
- After 3 silent attempts the pass is postponed to the next scheduled interval (no UI surface); error counted but not shown unless the next pass also fails, in which case it falls under Decision A's normal failure display.

The user is never told "another device is currently syncing"; it is internal noise.

## Decision C — Missing alarm permissions with pending reminders

When the app launches and finds one or more `Reminder` records in `state === 'pending'` whose required alarms cannot currently fire (any of `SCHEDULE_EXACT_ALARM`, `USE_FULL_SCREEN_INTENT`, `SYSTEM_ALERT_WINDOW` per ADR 0002 is missing), a homepage banner reads:

"`N` 个闹钟待响，缺权限 N 项，点这里去设置"

The banner is dismissible by the user for the remainder of the current app session; subsequent launches re-show it if permissions are still missing.

The "去设置" tap navigates to the OS system permissions page (per ADR 0002 contextual-lazy path; the dialog is opened in the OS context for the specific permission that is missing, not in a generic permission list).

## Decision D — Sync 3-way merge outcomes (user-visible only on conflict)

When a Sync pass completes:

- No surface on a clean merge — most users see nothing.
- If the merge result included any field, lost-conflict (where LWW lost one side's change to a field which became the winner), the home view shows a one-time toast: "已同步 N 条，其中冲突字段取最新 by updatedAt — 点击查看详情". The toast dismisses itself after 8 seconds; tapping opens a per-entity change view (per Sync history, which is retained per ADR 0004).
- The Sync history reader is a settings page listing the last 30 merges with timestamps and field-level diffs side-by-side. User can `Revert last merge` from there.

## Rationale

- The alarm-path failure modes (Decisions A and C) require surfaced UI state because they break a hard guarantee. Sync-path failures (Decisions A, B, D) the user can ignore without data loss — the next pass will retry, merge is idempotent under ADR 0004.
- WebDAV LOCK contention is internal — surfacing it to the user adds noise without adding useful action.
- Merge-result notifications surface only when the user had measurable data-at-stake (a field whose prior value was lost) — pure equality merges and union-diff additions do not toast.
- Sync history retention is sufficient depth (30 merges) to support the "Revert last merge" action; deeper history lives in the `snapshot.history.jsonl` retained per ADR 0004.

## Consequences

- Settings page gains a Sync status row, alarm-permission-status chip, and Sync history detail entries. UI state lives entirely in the per-session UI; Store is unchanged.
- The app's alarm path monitors `Reminder.state === 'pending'` AND alarm permissions on app launch to drive the Decision C banner.
- The Sync toast is rate-limited to once per app session per Sync pass that had conflicts (no flooding).
- A "Revert last merge" action is implemented as a discrete Snapshot operation: load `snapshot.history.jsonl` tail, swap to previous, trigger a Sync pass to propagate revert. Approved for v1.
- Out of scope: per-field undo beyond merge-level revert. If requested, it would itself require a re-merge-engine ADR than this ADR can encompass.
- Out of scope: failed push notifications of failures (no app server per ADR 0005, so the banner's existence is the only failure surface).
