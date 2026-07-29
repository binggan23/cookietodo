# PRD-0001: cookietodo v1 — cross-platform TypeScript todo + hard alarm

## Problem Statement

A user wants a single todo app they can install on Windows, Linux, and Android, in which they can manage personal todos and set alarms that reliably fire at the scheduled time — full-screen foreground takeover, audible, requiring the user to actively dismiss via a 6-digit password.

Existing solutions separate these concerns: todo tools (Todoist, TickTick, Things 3) ship reminders that are best-effort notifications, not hard alarms; alarm clocks (Google Clock, Apple Clock) do not integrate with todos. A serious user cannot trust "this todo will drag me out of bed at 6AM to do it" — they get a dismissable heads-up Notification that the OS quietly lets them swipe past.

The user's gap from their own perspective: "I want a todo tool whose reminder is a real alarm — full screen, audible, not dismissable by accident — installed once on each of my devices and, when I want it, sync'd across them."

## Solution

Build one TypeScript application — `cookietodo` — in a single pnpm monorepo, shipped to three platforms via two native shells:

- **Desktop (Windows, Linux)**: Electron 30+
- **Android**: Capacitor 7 with a custom Kotlin plugin implementing the Alarm Event

The app is **local-first**: each device's Store is authoritative; an optional Sync layer (manual file exchange + WebDAV) reconciles data across devices on launch + at a configurable interval. The Alarm Event is per-OS-native, never travels Sync — it fires reliably on each device it has been scheduled on, even when the app is backgrounded / screen is locked.

The Alarm Event is the differentiator: it is a hardened, full-screen foreground UI that plays a sound and only dismisses when the user enters a 6-digit numeric password set at first app launch. Snooze is allowed up to 3 times at 10-minute intervals; after the 3rd snooze the alarm stays on-screen + audible until either the correct password is entered or the device reboots (which leaves a visible "alarm was bypassed" banner in-app so the user must resolve the todo by hand).

## User Stories

### First launch & onboarding

1. As a new user, when I open the app for the first time, I want to be asked which language I prefer (简体中文 / English), so that subsequent screens are in my chosen language.
2. As a new user, immediately after picking my language, I want to be asked to set a 6-digit numeric password, so that the alarm dismissal flow I see later cannot be bypassed by accident.
3. As a new user, when I set my 6-digit password, I want to be asked to re-enter it for confirmation, so that I cannot lock myself into a password I mistyped.
4. As a new user, if my re-entry does not match the first input, I want to be returned to the previous screen to pick a different password, so I am not punished with a frozen flow.

### Todo creation & editing

5. As a user, I want to create a Todo with a title (max 200 chars) and optional Markdown notes, so that I can describe the work to be done.
6. As a user, when I create a Todo, I want it to optionally belong to zero or more Lists I've already created, so that I can group related work.
7. As a user, I want to optionally set a due date/time on a Todo, so that the app knows when this work is meant to be done.
8. As a user, I want to optionally attach a Reminder to a Todo — but only if I've also set a `dueAt`; a Todo without a dueAt cannot have a Reminder, so that I cannot create a Reminder that doesn't have a moment in time to fire at.
9. As a user, when I attach a Reminder, I want the Reminder's first `triggerAt` to default to the Todo's `dueAt`, so that I don't have to re-set the time.
10. As a user, I want to optionally make a Reminder recur (daily/weekly/monthly with interval, weekday mask, days-of-month including negatives like -1 = last day, nth-weekday like "2nd Tuesday"), so that repeated tasks like "every Monday standup prep" fire automatically each cycle.
11. As a user, I want my recurrence to optionally anchor on "due" (next fire from scheduled time) or "completed" (next fire from completion time — Todoist's `every!` / Obsidian Tasks' `when done`), so that "after I finish this weekly review, schedule the next one in 7 days" is a real choice.
12. As a user, I want to mark a Todo as complete, so that completed work moves off my active view.
13. As a user, when I un-mark a Todo as complete, I want the un-completion to be intentional (not auto-reverts from a sync quirk), so that completed stays completed unless I deliberately reopen.
14. As a user, when I delete a Todo, I want the deletion to be recoverable for 30 days via tombstones, so that an accidental delete on one device does not silently destroy work another device is mid-editing.

### List management

15. As a user, I want to create a List with a name (max 80 chars) and an optional color, so that my Todos have user-defined groupings.
16. As a user, when I add a Todo to List X on one device and simultaneously add the same Todo to List Y on another device, I want both additions to win at Sync time, so that silo'ing additions from each side silently drops one side's work.
17. As a user, when I add a Todo to List X on one device and simultaneously remove it from List X on another device, I want the addition to win, so that a unilateral remove does not delete another side's deliberate classification.

### Reminder scheduling & permission requests

18. As a user, when I save a Todo with a Reminder, I want the Alarm subsystem to register a scheduled intent with the OS, so that the alarm fires reliably even if the app is later backgrounded.
19. As a user, when I'm on Android 14+, I want the app to be positioned as an alarm-class application whose core function is alarm, so that `USE_FULL_SCREEN_INTENT` remains auto-granted (otherwise Google auto-revokes it for non-alarm-core apps since 2025-01-22).
20. As a user, when an Alarm Event fires and the app discovers a required permission is missing, I want the app to request that specific permission at that moment in context, so that I am asked for the permission when I have just been reminded why I need it.
21. As a user, when I refuse an alarm permission at the moment of Alarm Event fire, I want the Reminder to record that refusal (`permissionRefusedAt`) and stop nagging me every 5 minutes, so that the choice is sticky until I proactively revisit settings.
22. As a user, when I next launch the app and one or more pending Reminders cannot fire because permissions are missing, I want to see a dismissible banner listing which alarms are pending and which permissions are missing — with a "去设置" tap that takes me to the OS settings page, so that I can repair without leaving the home view.

### Alarm Event UX (the differentiator)

23. As a user, when an Alarm Event fires, I want the app to take over the foreground with a full-screen UI and a sound, so that I cannot miss the alarm by glancing away.
24. As a user, when the Alarm Event is on-screen, I want a one-tap "Sleep a bit" button that schedules a refire 10 minutes later, so that I can defer without committing to the password step.
25. As a user, after I have hit "Sleep a bit" 3 times, I want the snooze button to be removed from the UI, so that I cannot keep deferring the alarm indefinitely and accidentally sleep through my morning.
26. As a user, after the 3rd snooze, I want the alarm to stay on-screen and audible until I either enter my 6-digit password or reboot the device, so that the alarm insists on being resolved.
27. As a user, when I enter my 6-digit password correctly, I want the Alarm Event to dismiss AND the underlying Todo to be marked `completed=true, completedAt=now`, so that the dismissal is a commitment to completion — I cannot "close the noise" without committing to the work being done.
28. As a user, when I genuinely did not finish the work but dismissed via password, I want to be able to un-complete the Todo afterward in the app, so that password-dismiss as "force-commit" can be rolled back.
29. As a user, if I reboot my device to escape the post-3-snooze "must attend" Alarm Event, I want the app to surface a banner on next launch saying "你跳过了闹钟 — {todo.title} 未被关闭，标为继续待办", so that there is no silent "shut alarm by reboot = alarm never happened" loophole.
30. As a user, when I have the same Todo+Reminder synced across two devices and both are powered on at `triggerAt`, I accept that both devices will ring — accepting that avoiding dual-ring requires either an app-hosted backend or aggressive Sync intervals, both of which are out of scope for v1.
31. As a user, when Device A dismisses the Alarm Event (which is currently still ringing on Device B) and the next Sync pass propagates `Reminder.state = cleared` to Device B, I want Device B's still-on-screen Alarm Event to dismiss itself automatically, so that the dual-ring does not require me to manually dismiss on every device.

### Persistence & Import/Export

32. As a user, I want my entire todo + list + reminder state to be persisted as a single JSON file on each device, so that my data is durable across app restarts.
33. As a user, I want to Export my Snapshot to a JSON file, so that I can move it between my devices or back it up to external storage.
34. As a user, when I Import a Snapshot from a file, I want the importer to tolerate JSONC (comments, trailing commas), so that I can hand-edit an export when needed without breaking the round-trip.
35. As a user, when I Import a Snapshot from an older version of the app, I want missing fields to default sensibly so the import succeeds; when I import from a newer version, I want unknown fields to be preserved rather than dropped, so that forward/backward compatibility is non-destructive.

### Sync (optional)

36. As a user, I want to enable an optional Sync feature by configuring a WebDAV endpoint (Nextcloud, Caddy WebDAV, Syncthing, etc.), so that my Snapshots reconcile across my devices without me having to manually carry files.
37. As a user, when Sync is enabled, I want it to run automatically on app launch and at a configurable interval (default 5 minutes), so that data moves between my devices without me remembering to hit Sync.
38. As a user, I always want a "Sync now" button in Settings to force an immediate reconciliation when I remember I just made a critical edit.
39. As a user, when I am offline, I want Sync to silently pause and resume on reconnect, so that network loss is non-fatal to Sync on the next opportunity.
40. As a user, when a Sync merge loses one side of a conflicting field edit (because the field's merge semantic was LWW and the other side's `updatedAt` was newer), I want a one-time toast saying "已同步 N 条，其中冲突字段取最新 — 点击查看详情", so that I can audit contested merges without being flooded with every successful merge's chatter.
41. As a user, I want a Sync history view to see the last 30 merges with field-level diffs side-by-side and a "Revert last merge" action, so that regret after a confusing merge is reversible.
42. As a user, I want to manually exchange Snapshot files (USB stick, AirDrop, email-to-self) as a first-class Sync transport on day one, so that I do not need WebDAV to sync at all if I don't want to.
43. As a user, when my WebDAV connection fails, I want Settings to show a "上次同步：失败" row with the underlying cause and a "立即重试" button — but no popup or unrequested toast, so that the failure is recoverable info rather than annoying noise.
44. As a user, when my two devices both start a Sync pass simultaneously against the same WebDAV endpoint, I want the loser to silently back off 5s × 3 retries before deferring to the next interval, so that LOCK contention stays internal and the user surface stays clean.

### Failure modes & permissions UX

45. As a user, when I have alarm permission refused but pending Reminders, I want repeated App launches to keep reminding me via the missing-permission banner (not just a one-time prompt), so that the choice is sticky in my awareness until I either grant it or delete the Reminders.
46. As a user, when I'm about to set up WebDAV sync, I want my WebDAV credentials stored in the OS keychain (`safeStorage` on Electron desktop, Android Keystore), not in the Snapshot JSON traveling across devices, so that my credentials stay on the device I authorized them on.

### Localization & theming

47. As a user, I want the app to ship in 简体中文 and English at v1, so that I can use the app in either language without seeing raw keys or fallback strings.
48. As a user, when I have not explicitly chosen a language, I want the app to detect my OS locale and fall back to zh-CN if my locale is neither zh-CN nor en-US, so that first launch lands in a sensible default for me.
49. As a user, I want the app's dark/light color scheme to follow my system setting, so that the app does not present its own theme toggle competing with OS-level preference.

### Sound & alarm assets

50. As a user, I want 5 selectable alarm tones that ship with the app and are the same across Windows / Linux / Android, so that the alarm is recognizably "my cookietodo alarm" regardless of which device fired it.
51. As a user, I want a "试听" (preview) button in Settings so that I can audition each of the 5 tones and pick the one I want as my default.
52. As a user, I want my alarm tone choice to be a per-device preference (not part of the Snapshot), so that I can use a loud tone on my phone and a softer one on my desktop without forcing one to match the other.

## Implementation Decisions

### Modules

A pnpm workspace monorepo. Four layers split between one shared TypeScript workspace and two platform shells:

- **`src/domain/`** — Zod v4 strict schemas for `Todo`, `List`, `Reminder`, `Recurrence`; TS types derived from schemas. Single source of truth feeding both UI and the Snapshot JSON shape. ULID identifiers throughout.
- **`src/store/`** — Zustand store implementing all CRUD + the per-mutation `revision++` / `updatedAt = now` bump required by Sync.
- **`src/snapshot/`** — `parse.ts` (JSONC-tolerant parse via `jsonc-parser`, shared by Import paths in both shells), `serialize.ts` (strict JSON emit with deterministic key order from `z.object({...}).strict()`), the canonical Zod schema for the Snapshot envelope.
- **`src/sync/`** — the 3-way field-level merge engine; a Sync pass orchestrator; one-trip merge-and-write per ADR 0004.
- **`src/sync/transport/`** — two transport drivers: `manual.ts` (re-uses Import + Sync-shop) and `webdav.ts` (`webdav` npm package, ~300 LOC including LOCK token management + retry + 401 re-credential).
- **`src/alarm/`** — `AlarmAdapter.ts` (TS interface), `scheduler.ts` (computes next `triggerAt` from `Recurrence` using `@rrule/r rule` projected at fire-time only).
- **`src/persistence/StoreAdapter.ts`** — TS interface; implementations live in the shells.
- **`src/device/DeviceAdapter.ts`** — TS interface for `dismissPassword`, `alarmSoundId`, `locale`, `webdavCredentials`; implements backed by OS keychain.
- **`src/i18n/`** — `i18next` config, `zh-CN.json` and `en-US.json` catalogs compiled in.
- **`src/ui/`** — React 18 components + Zustand store subscriptions; Alarm Event fullscreen UI; first-launch password-setup + language-picker screen.
- **`apps/electron/`** — desktop shell. `ElectronAlarmAdapter.ts` (Node timer + `BrowserWindow` with `alwaysOnTop / fullscreen / skipTaskbar`), `ElectronStoreAdapter.ts` (Node `fs` atomic write: tmp + fsync + rename), Electron dark-mode via `nativeTheme`.
- **`apps/android/`** — Android shell. `capacitor-plugin-alarm/` (custom Capacitor plugin ~200 LOC Kotlin: `AlarmManager.setExactAndAllowWhileIdle` + `FOREGROUND_SERVICE_SPECIAL_USE` + `Notification.Builder.setFullScreenIntent` + fullscreen dismiss `Activity`, `CapacitorAlarmAdapter.ts` bridging); `CapacitorStoreAdapter.ts` (via `@capacitor/filesystem`); `CapacitorDeviceAdapter.ts` (Android Keystore via `@capacitor-community/preferences` or equivalent).

### Interfaces

- `StoreAdapter`: `loadSnapshot(): Promise<Snapshot>` / `saveSnapshot(s): Promise<void>` / `importSnapshot(file): Promise<Snapshot>` / `exportSnapshot(): Promise<File>`.
- `AlarmAdapter`: `scheduleAlarm(reminder: Reminder, todo: Todo): Promise<void>` / `cancelAlarm(reminderId: ID): Promise<void>` / `onAlarmFired(callback): void` / `requestPermission(kind): Promise<PermissionState>`.
- `DeviceAdapter`: `getDismissPassword(): string | null` / `saveDismissPassword(p)` / `getAlarmSoundId(): 1|2|3|4|5` / `saveAlarmSoundId(id)` / `getLocale(): 'zh-CN' | 'en-US'` / `saveLocale(l)` / `getWebDAVCredentials(url): { user, pass } | null` / `saveWebDAVCredentials(url, c)`.
- `SyncTransport`: `pull(): Promise<Snapshot | null>` / `push(merged): Promise<void>` / `acquireLock(): Promise<LockHandle>` / `releaseLock(handle): Promise<void>`.

### Architectural decisions

All decisions are recorded in `docs/adr/0001` through `0010` and align with the project `CONTEXT.md` glossary:

- **Local-first** per ADR 0003: each device's Store is the source of truth; Sync is best-effort overlay.
- **Alarm Event never travels Sync** per ADR 0002: per-OS-native scheduling; Cloud push is explicitly out of scope.
- **Snapshot is JSON** per ADR 0001; Import tolerant of JSONC; Export strict JSON with deterministic key order.
- **3-way field-level merge** per ADR 0004 with the per-field semantic table per ADR 0006 (scalar-3-way-LWW for `title` / `notes` / `dueAt` / `triggerAt` / etc.; set-union-with-diff for `listIds`, `daysOfMonth`, `nthWeekday`; monotonic-or for `completed` coupled to `completedAt`; cross-device monotonic for `permissionRefusedAt`; Reminder `state` resolved via the ADR 0006 state-machine LatticeTable where `fired > pending`, `cleared` monotonic, `cancelled` terminal).
- **Sync transports** per ADR 0005: manual file exchange + WebDAV; no provider abstraction, no cloud drive backends, no app-hosted backend (this is a hard scope cut).
- **Alarm UX** per ADR 0007 + 0009: forced 6-digit password at first-launch language selection; 10min × 3 snooze; post-3-snooze infinite ring until password or device reboot; dismiss ⇒ Todo `completed=true`;
- **Dual-ring tolerance** per ADR 0007: two devices both fire the same Reminder independently; the Sync-aftermath of one device's `cleared` triggers an alarm-cancel command on the other still-on-screen device.
- **Reboot escape** per ADR 0007: device OS-lifecycle ends the on-screen + audio path; Reminder state is sticky `fired` (never silently auto-`cleared`); in-app banner surfaces "you skipped this alarm — resolve it".
- **Sound** per ADR 0009: 5 tones, shared asset folder under `src/assets/alarm-sounds/`, shipped in `mp3` format. Specific tone selection deferred to implementation (must be CC0 / public-domain / commercially-clearable; license metadata in `src/assets/alarm-sounds/sources.md`).
- **i18n** per ADR 0010: i18next + react-i18next, compile-time catalogs (no per-locale fetch), `zh-CN.json` + `en-US.json` shipped in bundle; first-launch language picker precedes the password-setup screen.
- **Dark mode** per ADR 0009: follow system (`prefers-color-scheme: dark` on webview, `Configuration.UI_MODE_NIGHT_YES` on Android, `nativeTheme.shouldUseDarkColors` on Electron); no in-app theme toggle.
- **Failure UX** per ADR 0008: Sync failures show in Settings row (no toast / popup); LOCK contention silent 5s × 3 retries; missing permission banner in-app (dismissible per session); merge outcome toast only on actual conflicting-merge results; Sync history detail page + "Revert last merge".

### Schema changes

The domain model is defined in ADR 0006 with the additional constraint that `Reminder` requires its owning `Todo.dueAt` to be non-null. Key fields:

```ts
interface Todo {
  id: ID;          // ULID
  title: string;            // max 200 chars
  notes: string;            // Markdown, plain string (no block-AST)
  listIds: ID[];            // many-to-many owned by Todo
  completed: boolean;
  completedAt: number | null;
  dueAt: number | null;     // epoch ms; REQUIRED when reminderId non-null
  reminderId: ID | null;    // at most one Reminder per Todo
  createdAt: number; updatedAt: number; revision: number;
}

interface Reminder {
  id: ID; todoId: ID;
  triggerAt: number;        // epoch ms next UTC fire
  recur: Recurrence | null;
  state: 'pending' | 'fired' | 'cleared' | 'cancelled';
  snoozedUntil: number | null;
  snoozeCount: number;     // 0..3, 3 ⇒ disallow further snooze
  permissionRefusedAt: number | null;
  recurredTo: ID | null;   // next Reminder id when recurrence fires
  createdAt: number; updatedAt: number; revision: number;
}

interface Recurrence {
  kind: 'daily' | 'weekly' | 'monthly';
  interval: number;
  weekdayMask: number | null;
  daysOfMonth: number[] | null;     // supports negatives (-1 = last day)
  nthWeekday: { weekday: number; n: number }[] | null;
  count: number | null;
  until: number | null;
  anchor: 'due' | 'completed';
}

interface List {
  id: ID; name: string; color: string | null;
  createdAt: number; updatedAt: number; revision: number;
}
```

The `Snapshot` envelope wraps arrays of these entities plus a `deleted: Entity[]` tombstone array (with `deletedAt` per entity, GC'd after 30 days post cross-device Sync confirmation).

### API contracts

External (inter-shell with TS):
- `AlarmAdapter`, `StoreAdapter`, `DeviceAdapter`, `SyncTransport` (interfaces listed above).

External to the OS:
- Win/Linux desktop: Electron main process `BrowserWindow` + Node `fs` + Electron `safeStorage`.
- Android: Capacitor plugin invocation via the custom Kotlin plugin's exported `schedule` / `cancel` / `requestPermission` methods; `@capacitor/filesystem` `Filesystem.readFile` / `writeFile` against app-private external storage; `@capacitor-community/preferences` (or Android Keystore direct) for credentials.

### Specific interactions

- **First-launch flow**: language picker → 6-digit password set → confirm → home. Forced on first app entry; no skip.
- **Todo + Reminder creation in app**: on save of a Todo with `dueAt` and `reminder` selected, the Store writes the Todo, the Reminder, and calls `AlarmAdapter.scheduleAlarm(reminder, todo)` — which on Android sends an intent to the OS AlarmManager and on desktop sets a Node `setTimeout` keyed to `triggerAt - now` in the Electron main.
- **Alarm Event firing (Android)**: AlarmManager fires intent → custom Kotlin `AlarmPlugin` receives → foregrounds fullscreen `FullscreenActivity` → reads sound id from `DeviceAdapter.getAlarmSoundId()` → plays via `MediaPlayer` → reads user input (snooze tap or password digits) → on `password correct` returns `state=cleared` and reactive setter updates Store (`Todo.completed`, `Reminder.state`) → emits AppSync "Stop Alarm Event" observable that the in-flight on-screen UI listens to.
- **Alarm Event firing (Desktop)**: Electron main's `setTimeout` fires → opens fullscreen `BrowserWindow` with `alwaysOnTop: true` → renderer reads input → on `password correct` posts `state=cleared` back via IPC → main updates Store → if multiple windows of App open, the Sync-event listener for remote `cleared` state cancels the on-screen `BrowserWindow`.
- **Sync pass**: Sync orchestrator pulls remote Snapshot via `SyncTransport` → loads local `snapshot.json` and last known ancestor from `snapshot.history.jsonl` → invokes `mergeEngine.merge(local, remote, ancestor)` → writes result atomically to local `snapshot.json.tmp`, fsyncs, renames → appends merge entry to `snapshot.history.jsonl` → pushes result via `SyncTransport.push` → TTL check on tombstones for GC eligibility.
- **Sync-aftermath cancel of dual-fire**: A reconciled `Reminder.state === 'cleared'` arriving from remote triggers an in-flight "dismiss on-screen Alarm Event" emission local to the receiving device; the still-on-screen device's Alarm Event UI dismisses itself.

## Testing Decisions

### What makes a good test

Test only external behavior, never implementation details. A good test observes the user-visible or system-observable outcome (a Todo appears in the list, an alarm fires, a Snapshot file round-trips, a merge combines two device states into a single sane state) without asserting internal call sequences or private helper implementations. Tests that lock into implementation details create an obstacle to legitimate refactors.

### The single seam

v1 is verified through one eyebrow seam: a **behavioral E2E test chain driven by Playwright against the Electron Chromium desktop shell**, exercising the full v1 user flow:

- App launches → first-launch language picker → forced 6-digit password setup → home view.
- User creates a List → creates a Todo with `dueAt` in +5s → attaches a Reminder.
- Wait ~5s → Alarm Event fires full-screen with audible tone.
- User taps "Sleep a bit" 3 times → on 4th snooze attempt the button is gone → alarm stays full-screen.
- User enters correct 6-digit password → Alarm Event dismisses → Todo is now `completed=true` in the Store.
- User exports Snapshot to a JSON file → re-imports it into a fresh App state → Todo and Reminder survive the round-trip with identical field values.
- Manual cross-Sync PoC: two Snapshot JSONs (one with `title` change, one with `notes` change, common ancestor) imported sequentially via the manual transport + Sync-now button → resulting Store contains both changes; consumed via a UI list view assertion.

This seam covers: Alarm Event firing + dismiss = complete + 3× snooze + post-3-snooze infinite-ring; Store persistence and round-trip JSON; manual transport + 3-way merge; failure-path triggered permission request.

### Modules covered by the seam (via UI surfaces, not internal aspirational calls)

- `src/domain/` schemas (Zod round-trips implied by Export/Import assertions)
- `src/store/` (mutations observed via UI rows)
- `src/snapshot/` parse + serialize (via the file round-trip)
- `src/sync/merge.ts` (via the manual cross-merge PoC)
- `src/sync/transport/manual.ts` (via Sync-now)
- `src/alarm/scheduler.ts` (via Alarm Event firing on time)
- `apps/electron/main/ElectronAlarmAdapter.ts` (via the `BrowserWindow` appearing + dismissing)
- `apps/electron/main/ElectronStoreAdapter.ts` (via the JSON file existing and being re-importable)
- `src/ui/` (first-launch flow, todo/list create, alarm event UI, dismiss → complete)

### Modules left to lower-fidelity tests

- `src/sync/merge.ts` itself has Vitest unit tests for each of the field-level merge primitives (scalar-3way-LWW, set-union-with-diff, monotonic-or for `completed`, the Reminder state-machine table, the `permissionRefusedAt` monotonic rule) and for the high-level `merge(local, remote, ancestor)` entry point across simulated fixtures. These tests are not part of the Playwright seam — they are internal mathematics tests exercised directly via Vitest. They are part of the implementation's TDD workflow championed by project engineering discipline, not part of this PRD's behavioral verification.
- `apps/android/capacitor-plugin-alarm/` is exercised by an Android Espresso test that boots the plugin in isolation on an Android emulator, verifies that AlarmManager fires the intent on the scheduled time, the `FullscreenActivity` mounts, snooze tap and password entry each route to the right `Reminder.state` assertion. Espresso runs in CI for Android but does not block the desktop E2E seam.

### Prior art

There is no prior art in this repo. The seam's mechanical shape is borrowed from the Playwright + Electron integration pattern documented at https://playwright.dev/docs/api/class-electron — `electron.launch` + `electronApplication.firstWindow()` + selectors against the licensure DOM. The unit-test shape for merge primitives is borrowed from Vitest's standard `describe/it/expect`.

## Out of Scope

- **App-hosted backend / cloud sync**: explicitly out per ADR 0005. The "no App backend, no Service" rule. Cloud push (FCM/APNs) is not a v1 reliability mechanism for the Alarm Event — the alarm maintains reliability per-device via the OS AlarmManager (Android) and Electron timer (desktop).
- **OAuth cloud-drive backends (Google Drive, Dropbox, OneDrive)**: out per ADR 0005; WebDAV covers the self-hosted cases that matter to v1 users.
- **Cross-device "only one device rings" coordination**: out per ADR 0007. Dual-ring is accepted.
- **Lock-screen foreground takeover on Win/Linux** (forcing the screen on past the lock and covering the lock surface): out per ADR 0002; v1's desktop behavior at screen-locked state is sound-only, full-screen-foreground appears the instant the session unlocks.
- **Real-time collaborative note editing (block-level CRDT, Yjs, Loro)**: out per ADR 0006. `notes` field is LWW at field level (whole-string replace on concurrent edits).
- **CRDT-backed cross-device conflict resolution** for general fields: out per ADR 0004; v1 uses 3-way field-level merge.
- **Additional locales beyond zh-CN + en-US**: out per ADR 0010; future locales are catalog-file drops with tsconfig enum update.
- **Configurable snooze duration / count**: v1 fixed at 10min × 3 per ADR 0007.
- **Per-Todo or per-List alarms**: Tip. v1 alarm password is global per device (ADR 0009).
- **RTL layout**: v1 locales are both LTR.
- **Backup rotation policies beyond the 30-day tombstone and the 30-merge Sync history retention**: out for v1.
- **End-to-end Snapshot-at-rest encryption**: v1 Snapshot is plain JSON; transport is HTTPS on WebDAV. At-rest client-side encryption is a future ADR.
- **Alarm Sound user-imported override** (loading my own audio file): v1 ships 5 fixed tones.
- **Web/PWA build target**: out per ADR 0002; web-only deliver can't satisfy the Alarm Event hard requirement (`setFullScreenIntent` requires native `Notification.Builder`).
- **PRs as a triage queue**: out per `docs/agents/issue-tracker.md`. External PRs are not a triage path.
- **Routing day-1 on iOS, macOS**: Scope is Win/Linux/Android only.

## Further Notes

- **Engineering baseline (not ADR-grade)**: pnpm workspace, React 18 + Vite + Zustand + Zod 4 + Biome 2 (no ESLint/Prettier combo) + Vitest + Playwright + Electron 30 + Capacitor 7. TS strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) — no `as any`, no `@ts-ignore` (project rule).
- **Play Store listing** must include the "alarm as core function" rationale copy and demo video reviewer-facing — the `USE_FULL_SCREEN_INTENT` permission requests behavior a non-alarm app would get auto-rejected for; first Play Store submission may bounce 1–2 rounds on justification expectation.
- **Implementation-time open question** (deferred per grilling): the specific 5 alarm tone assets. They must be selected at implementation time from CC0 / public-domain / commercially-clearable sources (Freesound CC0, self-synthesized envelopes); the choices are recorded in `src/assets/alarm-sounds/sources.md` alongside the assets.
- **Implementation-time UX polish items deferred to `/prototype` skill output** (not PRD): List color palette choice (count and hex values), Todo display sort rule (drag-reorder persisted vs algorithmic sort by due date), per-Todo layout polish.
- **Domain vocabulary invariant**: not/skills consuming this PRD should use the project's glossary verbatim (`Todo`, `Reminder`, `Alarm Event`, `Store`, `Snapshot`, `Sync`, `List`) — non-canonical synonyms ("task", "alert", "backup", "Cloud") conceal the project's design intent.
- The PRD was authored from the 2026-07-28 grill-with-docs session; the source-of-truth decisions are in `docs/adr/0001` through `0010` and `CONTEXT.md` glossary.
