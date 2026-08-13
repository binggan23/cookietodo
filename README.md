# cookietodo

![CI](https://github.com/binggan23/cookietodo/actions/workflows/ci.yml/badge.svg)
![node](https://img.shields.io/badge/node-%E2%89%A520.10-blue)
![pnpm](https://img.shields.io/badge/pnpm-%E2%89%A59-orange)

A cross-platform (Windows + Linux + Android) TypeScript todo + hard-alarm app. Local-first, with optional WebDAV sync for cross-device reconciliation. One UI/business-logic codebase; two native shells (Electron desktop, Capacitor Android).

## Features

- **Todo management** — Create, edit, complete, delete todos with notes, due dates, and list organization
- **Hard alarm** — 6-digit password dismiss, 10min × 3 snooze, dismiss ⇒ auto-complete. Even when the app is backgrounded or locked (Android `AlarmManager.setExactAndAllowWhileIdle`, desktop `BrowserWindow` fullscreen takeover)
- **Recurring reminders** — Daily / weekly / monthly, with `due` or `completed` anchor ("every! 1 week" Todoist-style)
- **Local-first** — Your data stays on-device in a single JSON Snapshot file. No account, no cloud backend
- **WebDAV sync** — Point at any WebDAV endpoint (Nextcloud, Syncthing, Caddy) to sync across devices. 3-way field-level merge, LOCK contention, offline resilience
- **Import / Export** — Standard JSON Snapshot format, JSONC-tolerant on import. Carry your data manually

## Quick start

```bash
# Prerequisites: Node ≥ 20.10, pnpm ≥ 9
corepack enable && corepack prepare pnpm@latest --activate

git clone https://github.com/binggan23/cookietodo.git
cd cookietodo
pnpm install

# Build the renderer web bundle + Electron main process
pnpm --filter @cookietodo/renderer build
pnpm --filter @cookietodo/electron build

# Run in development mode
pnpm --filter @cookietodo/electron dev
```

## Package for distribution

```bash
# AppImage + .deb (Linux)
pnpm --filter @cookietodo/electron package

# NSIS installer (Windows — cross-compile on Linux requires wine)
pnpm --filter @cookietodo/electron package:win
```

Output goes to `apps/electron/release/`.

## Android

```bash
pnpm --filter @cookietodo/renderer build
npx cap sync android
cd android && ./gradlew assembleDebug
# APK at android/app/build/outputs/apk/debug/
```

Requires Android SDK. See [Capacitor Android docs](https://capacitorjs.com/docs/android) for setup.

## Project structure

```
cookietodo/
├── src/                  @cookietodo/renderer — shared UI + business logic
│   ├── src/domain/       Zod schemas + TypeScript types
│   ├── src/store/        Zustand store + hooks
│   ├── src/sync/         Sync orchestrator, merge engine, transport layer
│   ├── src/alarm/        Alarm scheduler, recurrence engine
│   ├── src/ui/           React components (HomeView, TodoForm, Settings, AlarmEvent…)
│   ├── src/device/       DeviceAdapter interface (per-device preferences)
│   └── src/persistence/  StoreAdapter interface (Snapshot I/O)
├── apps/electron/        Desktop shell (Electron 30)
│   ├── main/             Main process: StoreAdapter, DeviceAdapter, WebDAV transport
│   ├── preload/          contextBridge IPC proxies
│   └── e2e/              Playwright-Electron e2e tests
├── android/              Capacitor 8 Android project
│   ├── capacitor-plugin-alarm/  Custom Kotlin alarm plugin
│   └── app/…/FullscreenAlarmActivity.kt  Fullscreen alarm UI
├── docs/adr/             Architecture Decision Records (0001–0010)
└── .github/workflows/    CI: test + typecheck + lint + build
```

## CI

Every push runs: `pnpm test` (87+ unit tests), `pnpm typecheck`, `npx biome check`, `pnpm build`.

## Domain vocabulary

Read [`CONTEXT.md`](./CONTEXT.md) for the project's domain language (Todo / Reminder / Alarm Event / Store / Snapshot / Sync / List) and anti-overload rules.

## Architecture decisions

[`docs/adr/`](./docs/adr/) holds the 10 ADRs that define the v1 surface.

| # | Topic |
|---|-------|
| 0001 | Snapshot format is JSON (JSONC-tolerant on Import) |
| 0002 | Alarm reliability is "must fire" (Level B) with contextual-lazy permissions |
| 0003 | Persistence is one `StoreAdapter` interface backed by Capacitor Filesystem (Android) + Node `fs` (desktop) |
| 0004 | Sync is on-launch + interval-driven with versioned 3-way field-level merge |
| 0005 | Sync transport is manual file exchange + WebDAV only — no provider abstraction |
| 0006 | Domain model — Todo / List / Reminder / Recurrence field shapes and per-field merge semantics |
| 0007 | Alarm Event UX — 6-digit password dismiss, 10min×3 snooze, dismiss ⇒ complete, dual-ring tolerance, reboot escape |
| 0008 | Failure-mode UX — Sync errors, lock contention, missing permissions, merge outcome notifications |
| 0009 | Alarm UX supplemental — 5 tones, password setup on first launch, dark mode follows system |
| 0010 | i18n — compile-time catalogs for zh-CN + en-US with i18next |

## Agent skill wiring

[`AGENTS.md`](./AGENTS.md) is the entry point for engineering skills.