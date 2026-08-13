# cookietodo

> 本地优先的跨平台待办 + 硬闹钟应用。
> Local-first, cross-platform todo app with a hard alarm that *must* be dismissed.

![CI](https://github.com/binggan23/cookietodo/actions/workflows/ci.yml/badge.svg)
![license](https://img.shields.io/badge/license-MIT-blue)
![platform](https://img.shields.io/badge/platform-Linux%20|%20Windows%20|%20Android-blue)

---

## Features

- **Full todo management** — Create, edit, complete, delete. Notes with Markdown preview. Group by lists with colors.
- **Hard alarm** — When a reminder fires, the app takes over the full screen with a 6-digit password. No silent snoozing. The only way out: enter the correct password (completes the todo) or tap Sleep (max 3 times).
- **Recurring reminders** — Daily, weekly, monthly. Anchor by due date or by completion ("every! 1 week"). Uses `rrule` under the hood.
- **Local-first** — Your data is a single JSON file on your device. No account, no cloud, no vendor lock-in.
- **WebDAV sync** — Point at any WebDAV endpoint (Nextcloud, Syncthing, Caddy) to sync across devices. 3-way field-level merge — disjoint edits on two devices both survive.
- **Import / Export** — Standard JSON format. Carry your data however you like.
- **Dark mode** — Follows your system preference automatically.

## Download

| Platform | Package | How to install |
|----------|---------|----------------|
| **Linux** | [cookietodo-0.0.0-x86_64.AppImage](https://github.com/binggan23/cookietodo/releases/download/v0.1.0/cookietodo-0.0.0-x86_64.AppImage) | `chmod +x && ./cookietodo-*.AppImage` |
| **Linux** | [cookietodo-0.0.0-amd64.deb](https://github.com/binggan23/cookietodo/releases/download/v0.1.0/cookietodo-0.0.0-amd64.deb) | `sudo dpkg -i cookietodo-*.deb` |
| **Windows** | [cookietodo-0.0.0.exe](https://github.com/binggan23/cookietodo/releases) *(CI builds; coming soon)* | |
| **Android** | [app-debug.apk](https://github.com/binggan23/cookietodo/releases/download/v0.1.0/app-debug.apk) | `adb install app-debug.apk` or side-load |
| **Windows** | Installer *(coming soon)* | |
| **Android** | APK *(build from source)* | See below |

> Releases on the [GitHub Releases](https://github.com/binggan23/cookietodo/releases) page.

## Build from source

```bash
corepack enable && corepack prepare pnpm@latest --activate
git clone https://github.com/binggan23/cookietodo.git && cd cookietodo
pnpm install

# Desktop (Linux)
pnpm --filter @cookietodo/electron package
# → apps/electron/release/cookietodo-*.AppImage
# → apps/electron/release/cookietodo-*.deb

# Android
pnpm --filter @cookietodo/renderer build
npx cap sync android
cd android && ./gradlew assembleDebug
# → android/app/build/outputs/apk/debug/app-debug.apk
```

## First launch

1. Pick your language (English / 简体中文)
2. Set a **6-digit alarm password** — this is what you'll type to dismiss alarms
3. Create lists, add todos, set due dates and reminders

The password is stored in your OS keychain (desktop `safeStorage`, Android `Keystore`). It never leaves your device.

## Tech stack

| Layer | Technology |
|-------|-----------|
| UI + state | React 18 + TypeScript + Zustand |
| Schemas | Zod 4 |
| Desktop | Electron 30 |
| Mobile | Capacitor 8 + Kotlin (Android) |
| Sync | webdav + custom 3-way merge |
| Recurrence | rrule (computed at fire-time, never stored in snapshot) |
| Persistence | Single strict-JSON Snapshot (JSONC-tolerant on import) |
| CI | GitHub Actions (test + typecheck + lint + build) |

## License

MIT
