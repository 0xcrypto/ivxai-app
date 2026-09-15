# Contributing

```sh
cargo test --workspace            # bridge unit tests
cargo run -p ivx-bridge -- -v     # the daemon, chatty
npm --prefix web run mock         # a fake provider on :8124
```

A useful end-to-end check is a provider that sends *no* CORS headers, since that
is the case the bridge exists for. Point ivxai Chat at one, confirm the browser
refuses it, then turn the bridge on and confirm it streams.

## Updating the UI

`web/` is pinned to a commit. To move it:

```sh
git -C web pull origin main
git add web && git commit -m "Update web to <sha>"
```

Cloned without `--recurse-submodules`? `git submodule update --init`.

## Why the bridge rather than Tauri's HTTP plugin

Routing provider calls through Tauri's IPC and a Rust-side HTTP client would
mean a second networking path that only exists in the app, with its own
streaming behaviour and failure modes — and the UI would have to know which of
the two it was running on.

An initialization script is used rather than a Tauri command because it runs in
the webview's privileged context, so the app's `script-src 'self'`
Content-Security-Policy stays exactly as it is on the web.

## Mobile

Android and iOS build from this repository but are not part of a release.

```sh
npm run android:init      # tauri android init, plus the overlay below
npm run android           # needs the Android SDK and NDK
npx tauri ios init
npm run ios               # needs Xcode
```

`src-tauri/gen/` is generated rather than committed, so anything the template
leaves out has to be re-applied after each init. That is what
`scripts/android-overlay.mjs` does, and `npm run android` runs it for you.

What it fixes: the in-process bridge is reached over `http://`, and since
Android 9 a release build may not make a cleartext request. Tauri's generated
Gradle project sets `android:usesCleartextTraffic="false"`, which is right for
everything except the one hop that never leaves the phone — without the overlay
a release APK loads fine and then fails every provider call with
`ERR_CLEARTEXT_NOT_PERMITTED`. Debug builds set the flag to `true`, so
`npm run android` works and only the release APK is broken.

`src-tauri/android/` holds a network security config permitting cleartext to
`127.0.0.1` and `localhost` and nothing else, so the rest of the app stays
HTTPS-only.

## Releases

`.github/workflows/release.yml` runs on a `v*` tag: it opens a draft release,
then builds the app and the bridge for macOS, Windows and Linux. Publishing the
draft fires `.github/workflows/homebrew.yml`, which renders the templates in
`packaging/homebrew/` and pushes them to
[ivxlabs/homebrew-tap](https://github.com/ivxlabs/homebrew-tap). Prereleases are
skipped, so an `-rc` tag can exercise the pipeline without moving Homebrew
users.

Two things worth knowing before you touch it:

- **The macOS `.dmg` is allowed to fail.** Tauri's dmg step drives Finder over
  AppleScript to lay the window out, which needs a desktop session, and fails on
  a runner without one. The `.app.tar.gz` is built first and is the real
  deliverable, so the job warns and carries on.
- **The version lives in three files** — `Cargo.toml`, `package.json` and
  `src-tauri/tauri.conf.json` — and nothing keeps them in sync with the tag.
  Artefact names come from the tag; the version the app reports comes from
  those. The Homebrew formula asserts the two agree, so a mismatch surfaces
  there.

The tap needs a `HOMEBREW_TAP_TOKEN` secret: a fine-grained token scoped to the
tap repository with Contents: read and write, and nothing else.
