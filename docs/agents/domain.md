# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Layout: single-context

This repo is **single-context**: one `CONTEXT.md` at the root, one `docs/adr/` at the root. No `CONTEXT-MAP.md`; no per-module contexts.

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-snapshot-format-json.md
│   ├── 0002-alarm-reliability-and-permissions.md
│   ├── 0003-persistence-store-adapter.md
│   ├── 0004-sync-timing-and-merge-strategy.md
│   ├── 0005-sync-transport-manual-and-webdav.md
│   ├── 0006-domain-model-fields-and-merge-semantics.md
│   ├── 0007-alarm-event-ux.md
│   ├── 0008-failure-mode-ux.md
│   ├── 0009-alarm-ux-supplemental-sound-password-dark.md
│   └── 0010-i18n-compile-time-catalogs-two-locales.md
└── src/  (future)
```

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the domain glossary for Todo, Reminder, Alarm Event, Store, Snapshot, Sync, List. Defines anti-overload language rules (e.g. "Alarm" the noun always means Alarm Event; never used loosely).
- **`docs/adr/*.md`** — read ADRs that touch the area you're about to work in. ADRs 0001–0010 cover the v1 architectural surface: Snapshot format, alarm reliability, persistence, Sync merge, Sync transport, domain model, alarm UX, failure-mode UX, alarm sound + password + dark-mode defaults, i18n.

If any of these files don't exist at the time you're invoking a skill, proceed silently. Don't flag their absence upfront.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as **defined in `CONTEXT.md`**:

- A `Todo` is the user-created item. Not "task", not "job", not "reminder" (a `Reminder` is the alarm-tied scheduled intent — a different concept).
- An `Alarm Event` is the distinguished state the `Reminder` enters when it fires: full-screen foreground takeover with sound and a dismiss button. Not "notification", not "alert", not "popup" — those don't carry the hard-takeover guarantee.
- The `Store` is the per-device authoritative copy of the user's data; `Sync` is the optional reconciliation channel. Don't merge them as "Cloud" or "database".
- A `Snapshot` is the serializable representation of the Store at a point in time, used by Import/Export and Sync. Format: JSON (per ADR 0001). Not "backup", not "file", not "dump".

If a concept you need isn't in the glossary, that's a signal — you're either inventing unsupported language (reconsider) or finding a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (alarm UX — 6-digit password dismiss) — but worth reopening because…_
