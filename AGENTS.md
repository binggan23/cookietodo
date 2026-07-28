# AGENTS.md — engineering-skills entry point for `cookietodo`

This file is consumed by engineering skills (`to-issues`, `triage`, `to-prd`, `qa`, `tdd`, `diagnosing-bugs`, `improve-codebase-architecture`) to understand how this repo is wired up. It is the entry point that points at the three below.

## Agent skills

### Issue tracker

Issues and PRDs live as **GitHub issues** in `binggan23/cookietodo`, operated via the `gh` CLI. External pull requests are NOT treated as a triage surface (this is a personal / solo repo). See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles map 1:1 to label strings in this repo: `needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`. All five already exist as GitHub labels. See `docs/agents/triage-labels.md`.

### Domain docs

**Single-context** layout: one `CONTEXT.md` at the repo root, one `docs/adr/` at the repo root. No `CONTEXT-MAP.md`, no per-module contexts. See `docs/agents/domain.md`.

## Quick orienteering for any incoming agent

Before touching code or answering an architectural question, in order:

1. Read `CONTEXT.md` — learn that "Alarm" means Alarm Event, that `Store` ≠ Sync, that `Reminder` ≠ Todo, that a `Snapshot` is the JSON-serializable Store image (ADR 0001).
2. Read the relevant ADRs from `docs/adr/`. The architecture decisions are final-recorded there; re-deriving them from code is wrong.
3. Use the project's domain vocabulary verbatim in your output.

## Engineering baseline (informal — recorded here so agents don't re-derive)

- pnpm workspace monorepo; TS strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) — no `as any`, no `@ts-ignore`.
- React 18 + Vite + Zustand + Zod 4 + Biome 2 + Vitest + Playwright.
- Two native shells: Electron 30 (Win/Linux desktop), Capacitor 7 (Android). Custom Kotlin plugin implements the Alarm Event on Android.
- See ADRs 0001–0010 for the full architectural surface.
