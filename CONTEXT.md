# Todo & Alarm

A personal time-management tool: maintain todo items and fire a hard full-screen alarm at scheduled times. Built local-first with optional cross-device sync, shipped to Windows, Linux, and Android from one TypeScript UI/business-logic codebase under two native shells (Electron desktop, Capacitor Android).

## Language

**Todo**:
A user-created item with a title, optional notes, a due time, and a completion state. Belongs to zero or more Lists.
_Avoid_: Task, job, reminder (reminder is a separate concept, see below)

**Reminder**:
A pending notification tied to a Todo's due time, fired by the OS-level alarm subsystem. The alarm firing IS the reminder becoming active; before that, a Reminder is just a scheduled intent.
_Avoid_: Alert, notification (notification is the generic OS concept; Reminder is the todo-bound one)

**Alarm Event**:
The distinguished state of a Reminder at the moment it fires: a full-screen foreground takeover with sound and a dismiss button. Hard requirement: must fire on time even if the app is backgrounded/locked/screen-off.
_Avoid_: Notification, popup, modal (those don't carry the hard-takeover guarantee)

**Store**:
The per-device authoritative copy of the user's Todos, Lists, Reminders, and Dream state. Local-first: the Store IS the source of truth on each device; sync is a non-authoritative overlay.
_Avoid_: Database, cache, account

**Snapshot**:
A serializable representation of the Store at a point in time, used by Import/Export and as the unit that crosses the Sync channel. Format TBD (JSON vs XML) — this is the live grilling question.
_Avoid_: Backup, file, dump (those are storage mechanisms; Snapshot is the logical content)

**Sync**:
The optional, user-enabled mechanism that reconciles Snapshots across multiple devices' Stores. Best-effort, conflict-tolerant; never the path the Alarm Event travels.
_Avoid_: Cloud, account, server (those are implementation; Sync is the conceptual relationship)

**List**:
A user-named grouping of Todos. A Todo can be in zero or more Lists.
_Avoid_: Project, folder, category, tag (use "tag" for free-form labels; List is the named bucket)

## Rules

- "Alarm" the noun always means Alarm Event in this domain; never used loosely. If we mean the OS subsystem we say "alarm subsystem" / "AlarmManager".
- "Sync" and "Store" stay separate on purpose: the Store is authoritative per device; Sync is not a database, it's a reconciliation channel.
