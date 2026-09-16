# Contributing

```sh
cargo test --workspace            # bridge unit tests
cargo run -p ivx-bridge -- -v     # the daemon, chatty
npm --prefix web run mock         # a fake provider on :8124
```

A useful end-to-end check is a provider that sends *no* CORS headers, since that
is the case the bridge exists for. Point ivx/ai Chat at one, confirm the browser
refuses it, then turn the bridge on and confirm it streams.

## Updating the UI

`web/` is pinned to a commit. To move it:

```sh
git -C web pull origin main
git add web && git commit -m "Update web to <sha>"
```

Cloned without `--recurse-submodules`? `git submodule update --init`.

## The icon

`src-tauri/icons/` is generated, and the mark is drawn by the web repository so
both the PWA and the app show the same thing. To change it, edit the drawing in
`web/tools/make-icons.mjs` (and `web/public/icons/icon.svg` to match), then:

```sh
node web/tools/make-icons.mjs /tmp/icon-1024.png 1024
npx tauri icon /tmp/icon-1024.png
```

That rewrites the whole set — `.icns` for macOS, `.ico` for Windows, the PNG
sizes and the Windows Store logos.

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
- **The version has one home:** `[workspace.package]` in `Cargo.toml`. Both
  crates inherit it, and `tauri.conf.json` has no `version` field so Tauri falls
  back to Cargo. `scripts/version.mjs` writes it and mirrors it into
  `package.json`; `npm run bump <patch|minor|major|X.Y.Z>` is the only way it
  should ever change. The draft job runs `--check "$TAG"` and refuses to open a
  release whose tag disagrees.

The tap needs a `HOMEBREW_TAP_TOKEN` secret: a fine-grained token scoped to the
tap repository with Contents: read and write, and nothing else.
