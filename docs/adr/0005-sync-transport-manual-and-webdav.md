# ADR 0005: Sync transport is manual file exchange + WebDAV only. No provider abstraction

**Date**: 2026-07-28
**Status**: Accepted

## Context

ADR 0001 defined `Snapshot` as JSON. ADR 0004 defined *when* Sync fires and *how* two Snapshots merge (3-way field-level merge, modify-wins-over-delete). Q8 of the 2026-07-28 grilling session closes the remaining gap — the **physical transport** by which two devices' Snapshots meet.

## Decision

v1 ships exactly **two Sync transports**:

1. **Manual file exchange** — the user carries an exported Snapshot file from one device to another using any existing mechanism (U盘, AirDrop, email-to-self, MTP). The destination device's existing Import flow (from ADR 0001 / ADR 0003) consumes the file; the user then taps the existing "Sync now" button (from ADR 0004) to trigger 3-way merge against the imported Snapshot.
2. **WebDAV** — the app authenticates against a user-provided WebDAV endpoint (Nextcloud, Caddy WebDAV, Syncthing's WebDAV gateway, box.com, Synology Drive, etc.). On each Sync pass (launch / interval / now-button per ADR 0004) the app `GET`s the remote Snapshot into a working copy, performs the merge against local + last-known common ancestor, and `PUT`s the merged result back. `LOCK / UNLOCK` against the WebDAV endpoint defends against two devices writing concurrently.

**No provider abstraction layer. No OAuth cloud-drive backends (Google Drive / Dropbox / OneDrive). No app-hosted backend.** Future transdirect (if v1 ships and demand appears) is a fresh ADR and a fresh engagement, not an interface extension of v1.

## Rationale

- Manual exchange is **zero extra engineering**: it is exactly the Import/Export + Sync-now flow ADRs 0001, 0003, 0004 already specified. Listing it as a transport makes v1's Sync feature complete on day one even before WebDAV lands — WebDAV is *optional ergonomics*, not v1's only Sync path.
- WebDAV is an IETF-track standard; a single client implementation covers every major self-hosted option without OAuth dance per provider. v1's effort is one WebDAV client, not three cloud-drive SDKs.
- Provider-abstraction was considered and rejected. The "abstract Sync into `TransportAdapter` interface, ship two drivers in v1, leave slots for cloud-drive and self-hosted backend" pattern was rejected because forecasting that users want Google Drive (vs Dropbox vs OneDrive vs iCloud) vs an app-hosted backend is **a product-strategy question, not a technical one**. If we picked the wrong future, an abstraction designed today is the wrong abstraction; if v1 demand shows a clear winner, building it directly then is cheaper than retrofitting an over-generic interface now.
- Pure peer-to-peer LAN (mDNS + direct transfer) was rejected: the real cross-device todo use-case ("add todo on Android, see it on Windows laptop later") has the two devices frequently not co-located and not simultaneously online.
- An App-hosted backend is rejected for v1 because it would force account creation on a tool that otherwise is local-first (contradicts ADR 0003's per-device Store authority) and adds operational burden with no measurable benefit over WebDAV for the target user pool.

## Consequences

- v1 implements a single WebDAV client (`webdav` npm package as starting point, ~300 lines TS including `LOCK` token management, retry, 401 re-credential). Per-adapter logic is **two** end-points only: the manual flow reuses Import; WebDAV implements `GET / PUT / LOCK` per remote endpoint.
- A new `CredentialsAdapter` interface is introduced minimally — WebDAV credentials are stored in each platform's native Secret Manager (Electron `safeStorage` on Win/Linux, Android `Keystore` via `@capacitor-community/preferences` or equivalent). Not abstracted beyond "give me the credential named `webdav.<url>`"; no generic provider store.
- Transport security in v1 is **transport-layer only**: WebDAV endpoints are required to be HTTPS; the Snapshot in transit is plain JSON. End-to-end Snapshot-at-rest encryption is out of scope — a separate grilling question (Q9 candidate) if requested.
- The conflict-resolution logic from ADR 0004 runs identically on both transports; `LOCK / UNLOCK` exists solely to prevent two devices `PUT`ting concurrently over each other, not to prevent logic-level conflicts (which the 3-way merge already resolves).
- The user's mental model is "either I move the file myself, or I configure my WebDAV endpoint once." There is no account, no cloud-drive picker, no in-app upsell for additional providers.
- Out of scope and limited: adding a cloud-drive backend or app-hosted backend is not a v1.x extension. It will be evaluated separately as a fresh product decision with its own ADR. The Store / Snapshot / Sync pass / 3-way merge code is intentionally written transport-agnostic *at the Sync-pass layer* (ADR 0004); transport changes will reuse that core, but they will not slot into a v1 abstraction seam.
