# README — cookietodo

A cross-platform (Windows + Linux + Android) TypeScript todo + hard-alarm app. Local-first, with optional WebDAV sync. One UI/business-logic codebase; two native shells (Electron desktop, Capacitor Android).

## Status

Pre-implementation. Architecture decided; no application code yet.

## Domain vocabulary

Read [`CONTEXT.md`](./CONTEXT.md) for the project's domain language (Todo / Reminder / Alarm Event / Store / Snapshot / Sync / List) and the anti-overload rules.

## Architecture decisions

[`docs/adr/`](./docs/adr/) holds the 10 ADRs that fix the v1 design surface:

| # | Topic |
|---|---|
| 0001 | Snapshot format is JSON (JSONC-tolerant on Import) |
| 0002 | Alarm reliability is "must fire" (Level B) with contextual-lazy permissions |
| 0003 | Persistence is one `StoreAdapter` interface backed by Capacitor Filesystem (Android) + Node `fs` (desktop) |
| 0004 | Sync is on-launch + interval-driven with versioned 3-way field-level merge |
| 0005 | Sync transport is manual file exchange + WebDAV only — no provider abstraction |
| 0006 | Domain model — Todo / List / Reminder / Recurrence field shapes and per-field merge semantics |
| 0007 | Alarm Event UX — 6-digit password dismiss, 10min×3 snooze, dismiss ⇒ complete, dual-ring tolerance, reboot escape |
| 0008 | Failure-mode UX — Sync errors, lock contention, missing permissions, merge outcome notifications |
| 0009 | Alarm UX supplemental — 5 tones shared cross-platform, password setup forced on first launch, dark mode follows system |
| 0010 | i18n — compile-time catalogs for zh-CN + en-US with i18next |

## Agent skill wiring

[`AGENTS.md`](./AGENTS.md) is the entry point for engineering skills (`to-issues`, `triage`, `to-prd`, `tdd`, `diagnosing-bugs`, `improve-codebase-architecture`). Domain doc consumer rules at [`docs/agents/`](./docs/agents/).
