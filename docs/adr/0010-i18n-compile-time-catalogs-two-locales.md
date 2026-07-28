# ADR 0010: i18n — compile-time catalogs for two locales (zh-CN, en-US) with i18next

**Date**: 2026-07-28
**Status**: Accepted

## Context

Q10 of the 2026-07-28 grilling session closed the localization question — the app ships two locales at v1 (zh-CN, en-US) using `i18next` + `react-i18next` with compile-time catalogs bundled into the JS payload. This addresses ADR 0009's note about L10n being deferred and replaces the implicit "v1 zh-CN-only" recommendation that was superceded by the user's instruction to do i18n.

## Decision

- **Library**: `i18next` v25+ and `react-i18next` v15+. Both maintained, both Vite / Electron / Capacitor compatible, both JSON-catalog based.
- **Locales at v1**: zh-CN (default) and en-US. The full UI surface is translated into both; no locale renders raw keys or English-only fallback strings.
- **Catalog loading**: compile-time import. The full catalogs for both locales are statically imported into the JS bundle in both shells (Electron app, Capacitor Android APK). There is no per-locale fetch at runtime.
- **Locale detection**:
  1. User-chosen locale persisted in the per-device preference store (alongside `dismissPassword` and `alarmSoundId` per ADR 0009's `DeviceAdapter`) — a "selected" preference wins.
  2. When no user-chosen preference exists, fall back to the OS-reported locale (`navigator.language` in WebView, `app.getLocale()` in Electron, `LocaleManager` via Capacitor plugin on Android).
  3. If the OS locale matches neither `zh-CN` nor `en-US` (e.g. `ja-JP`), fall back to `zh-CN`.
- **First-launch language pick**: there is a single short language-picker step before the ADR 0009 password-setup screen. The user picks `简体中文 / English`; the choice is stored as the per-device `locale` preference immediately.

## Rationale

- Compile-time catalogs (option A from Q10) chosen over per-locale fetch (option B) and key-only-fallback (option C):
  - Bundle size cost (~250 KB for 5 locales; ~100 KB for 2 at v1) is negligible across all three platforms. APK +250KB in 2026 is well under the median user perception threshold.
  - WebView fetch-on-language-switch (option B) costs ~150 LOC of plugin glue (Capacitor Filesystem catalog reading + JSON parse + i18next.addResourceBundle orchestration) and adds a 100–500ms first-switch latency; not justified for two locales.
  - Option C's key-string-fallback risk is rejected because a user lands on an unsupported language and sees raw keys (or worse, English strings) is a UX failure mode for a personal data tool where the user is alone with their todos.
- i18next chosen because of the React+Vite ecosystem fit, JSON-catalog convention, and TypeScript type-safety (`react-i18next` ships typed `t()` with i18next-typecheck addons at the cost of one TS build step).
- Two locales, not more: zh-CN is the user's stated primary; en-US is the global default. Adding more locales later is a zero-touch resource addition (new catalog file + re-build); no further design touch.
- Intl APIs (not a date library like dayjs / moment) handle date and time formatting. The OS locale and `Intl.DateTimeFormat` ecosystem is sufficient; shipping a second date library for a todo app is unnecessary dependency weight.

## Consequences

- Every UI string must be `t('namespace.key')` key calls. Hardcoded user-visible strings in TSX are rejected at PR review (Biome rule capable; manual review for v1).
- Two catalog files ship: `src/i18n/locales/zh-CN.json` and `src/i18n/locales/en-US.json`. Same keys, same structure. Catalog namespace organization follows the route structure (`home.*`, `settings.*`, `alarm-event.*`, `first-launch.*`).
- A `DeviceAdapter.getLocale()` / `saveLocale(l: 'zh-CN' | 'en-US')` method joins the already-defined `DeviceAdapter` (per ADR 0009). Default resolves via the three-step detection order above before persisting.
- First-launch flow gains a step **before** the ADR 0009 password-setup screen: language-picker. The user sees `语言 / Language: [简体中文] [English]` as a tap-pair, then proceeds to the password screen.
- Number formatting follows the chosen locale via `Intl.NumberFormat`. Currency formatting is out of scope (the app has no currency concept).
- Pluralization uses i18next's standard `_one` / `_other` suffix convention (`t('todos.count', { count: n })`); no language with complex plural rules is in scope at v1, so no `_zero` / `_few` / `_many` rule complexity.
- Adding a third locale (e.g. ja-JP, ko-KR) at v2 is a catalog-file drop + tsconfig enum update; no architectural change.
- All ADRs that reference UI surface strings now implicitly inherit this convention. In particular:
  - ADR 0007's alarm UX strings ("Sleep a bit" / "Enter password") are i18next keys.
  - ADR 0008's failure banner strings ("上次同步：失败" etc.) are i18next keys.
  - ADR 0009's first-launch flow has its own `"first-launch.*"` namespace.
- Out of scope: RTL layout work (zh-CN and en-US are both LTR; RTL is a vN concern if Arabic or Hebrew are added).
- Out of scope: locale-aware date / time math (.calendar, .fromNow) library — `Intl` covers this; if richer relative-time strings prove necessary v2 adds a small `Intl.RelativeTimeFormat` helper, not moment/dayjs.
