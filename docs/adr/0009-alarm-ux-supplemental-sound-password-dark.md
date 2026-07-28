# ADR 0009: Alarm UX supplemental — sound set, password-first-flow, dark mode

**Date**: 2026-07-28
**Status**: Accepted

## Context

ADR 0007 settled the Alarm Event surface (password-dismiss, snooze bounds, B2 dismiss ⇒ complete, dual-ring tolerance). Subsequent grilling closed three remaining UX questions that ADR 0007 explicitly left open:

1. Alarm sound set — how many, sharing vs per-platform assets, and the rights-clearance path.
2. Preparation flow for the 6-digit dismiss password — pre-set on first app launch or wait until the user creates their first alarm-bearing Todo.
3. Dark-mode default policy.

## Decision A — Alarm sound set: 5 tones, shared across platforms, royalty-free via internet search at implementation time

The Alarm Event ships with exactly **5 selectable alarm tones**. The same five tones ship to all three platforms (Windows, Linux, Android); asset bytes are stored once in `src/assets/alarm-sounds/` and consumed unchanged by both shells (Electron plays via Web Audio / `<audio>`, Capacitor plays via the native `MediaPlayer` exposed through a thin custom plugin if Web Audio is daemon-locked).

Tone selection at implementation time follows the rule: all 5 tones must be **royalty-free, license-clear for commercial reuse** (sources: CC0 sample packs, public-domain alarm-tone collections like Freesound CC0 tracks, Zimmer/Sthagen royalty-free tone generator output, or self-synthesized sine/sawtooth envelopes). The specific asset selection is deferred to the implementation phase where internet search engines identify and license 5 tones; this ADR fixes the **count and policy**, not the titles.

User settings store **one** `alarmSoundId: number (1..5)` preference (per-device preference, not part of Snapshot by ADR 0001's contract: a per-device UX credential akin to the dismiss password). Default selection is tone `#1`; a per-device "先试听" preview button is offered in Settings.

Why 5:

- Below 5, users feel locked-in by the alarm. Above 5, choice paralysis at race-against-the-clock moment (an alarm moment is "stop it", not "decide what sound it'll make next time").
- 5 is the count Apple Clock (iOS 17 stock alarm sounds ~ 8 free + paid packs) and the Google Clock app (~ 6 default tones) settle on after years of tuning.

## Decision B — Password setup is forced on first app launch

The very first screen the user sees when they open the app — even before any Todo creation UI — is a single-purpose screen:

```
欢迎使用 {App}。
设置你的6位闹钟密码 —— 该密码用于关闭闹钟，
请你设置一个6位数字密码，并把6位数字记住。
[____ ____ ____ ____ ____ ____]
[继续]
```

The user may not bypass this screen — there is no "later" / "skip" button. After setting, a confirmation prompt asks the user to re-enter the 6 digits; mismatch loops back. Two consecutive mismatches offer a "back to previous screen / set differently" off-ramp (no rate limit; the user is not a threat actor here).

The password is stored in the device's native secure credential store immediately on confirmation (Electron `safeStorage.encrypt` to local keyring; Android `Keystore`). After this screen, the user reaches the standard home.

ADR 0007 implied password setup would happen "during first alarm-create flow" — this ADR moves it earlier to first-app-launch, so that the user never has to set up security policy from inside an `add-todo + reminder` form. UX rationale: the security commitment belongs to the installation moment, not to the todo-creation moment. This overrides the relevant clause in ADR 0007 silently.

## Decision C — Dark mode follows the system

The app does not maintain its own light/dark toggle. The UI observes the OS-level dark-mode preference (Android `Configuration.UI_MODE_NIGHT_YES`; Electron `nativeTheme.shouldUseDarkColors`; webview `prefers-color-scheme: dark`).

In-app theme accent follows same system signal; no user setting persisted (consistent with ADR 0001 not modelling preference state as part of Snapshot).

## Rationale

- 5 tones count is the median of the user-tested alarm app market plus the implementation simplicity of a single shared asset folder.
- Forced password at first launch is annoying one time, but deferred to alarm-create means a user creating their first alarm at 22:30 in bed will be annoyed at exactly the wrong moment (typical first-Todo-create flows). Front-load the security commitment to the well-rested install moment.
- Dark-mode-from-system is the cheapest and lowest-friction decision; it makes no preference choices for the user and matches OS-appearance-on-all-three-platforms behaviour.

## Consequences

- `src/assets/alarm-sounds/` directory will hold 5 audio files at implementation time. Asset format: `mp3` (Android-supported natively, Electron / Chromium supports natively) — single format, no per-shell encoding forks.
- Per-device preference: `dismissPassword` (set per Decision B), `alarmSoundId` (1..5 select) — both live in the OS Keychain, neither carried by Snapshot. A new `DeviceAdapter` interface (`getDismissPassword(): string`, `saveDismissPassword(p: string): void`, `getAlarmSoundId(): number`, `saveAlarmSoundId(id: number): void`) joins `StoreAdapter` and `AlarmAdapter` along the same shell-vs-TS split Q5 established.
- The implementation team must verify each tone's license before commit (CC0 / public domain / commercial-license-clear); licensing metadata is recorded per file in `sources.md` next to the assets.
- First-launch flow has one forced screen (Decision B); a "verify password" reuse step.
- Dark-mode is implemented via CSS `prefers-color-scheme` with two `:root` style sheets; no in-app toggle exists in Settings. (A future ADR reserved for "respect system except a settings override" if requested in v2).
- Play Store asset filtering: no theme-mode-bound screenshots required; standard single set works.
