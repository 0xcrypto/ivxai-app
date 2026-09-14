# NilgAI app

Two ways to get past CORS, sharing one implementation.

[NilgAI UI](https://github.com/0xcrypto/nilgai) is a chat client that runs
entirely in a browser and talks straight to whatever endpoint you point it at.
That works right up until the endpoint does not send CORS headers — Ollama on
its defaults, a bare llama.cpp build, a private proxy someone set up years ago.
Those servers are running fine. The browser simply will not let a web page
speak to them.

This repository fixes that twice over:

- **`nilgai-bridge`** — a 2 MB daemon. Install it, leave it running, and the
  hosted app at <https://o.eval.blog/nilgai> reaches every endpoint on your
  machine. No app to install, nothing to keep updated.
- **The NilgAI app** — desktop and mobile, built with Tauri. Same UI, with the
  same bridge running inside it. Nothing to configure.

The UI itself is not here. `web/` is a submodule pointing at the
[nilgai](https://github.com/0xcrypto/nilgai) repository, so the web app stays a
web app and this repository stays about shipping it.

```
web/                        submodule: NilgAI UI, unchanged
crates/nilgai-bridge/       the CORS bridge — library and daemon
src-tauri/                  the Tauri shell, which embeds that library
```

## Getting it

```sh
git clone --recurse-submodules https://github.com/0xcrypto/nilgai-app
cd nilgai-app
npm install          # also installs the web app's dependencies
```

Already cloned without `--recurse-submodules`? `git submodule update --init`.

| What | Command | Needs |
| --- | --- | --- |
| The bridge alone | `cargo build --release -p nilgai-bridge` | Rust |
| Desktop app | `npm run build` | Rust, Node, [Tauri prerequisites](https://tauri.app/start/prerequisites/) |
| Desktop, running | `npm run dev` | same |
| Android | `npm run android` | + Android SDK/NDK |
| iOS | `npm run ios` | + Xcode |

Mobile needs its platform project generated once, before the first run:

```sh
npx tauri android init
npx tauri ios init
```

## The bridge

```sh
cargo build --release -p nilgai-bridge
./target/release/nilgai-bridge
```

```
nilgai-bridge 0.1.0 on http://127.0.0.1:8787
  accepting: http://localhost:*, https://o.eval.blog, …
  connect:   NilgAI UI -> Settings -> CORS bypass -> Look for the bridge
```

Then in the app: **Settings → CORS bypass → Look for the bridge**. It checks
`127.0.0.1:8787`, and once it answers, provider calls go through it. The switch
turns it off again at any time.

To keep it running across reboots:

```sh
nilgai-bridge --install-service      # launchd on macOS, systemd --user on Linux
nilgai-bridge --uninstall-service
```

Any options you pass alongside `--install-service` are baked into the service,
so `--install-service --port 9000 -v` installs it on port 9000 with logging.
On Windows there is no equivalent; use Task Scheduler, or a shortcut in
`shell:startup`.

### What it does

One route. `POST /proxy?url=<absolute URL>` forwards the request to that URL
and streams the answer back, with the CORS headers a browser needs.

- **Nothing is inspected.** It does not know what a chat completion is and never
  parses a body. Responses are piped through frame by frame, so a streamed
  completion still arrives token by token.
- **Nothing is kept.** No disk, no cache, no request log. `-v` prints one line
  per request — method, host, status — and never headers or bodies. Your API key
  travels in the headers the browser set, to the endpoint you configured.
- **Browser-specific headers are dropped** before the request goes out:
  `Origin`, `Referer`, `Cookie`, `Accept-Encoding`. Several providers reject a
  request that claims to come from a web page they do not recognise.
- **`GET /health`** says what version and protocol it speaks, and whether it
  would accept the asking origin. The app uses that to tell "nothing is
  listening" apart from "listening, but not for you" — which a bare CORS failure
  cannot distinguish.

### Who is allowed to use it

This is the part worth understanding before you run it. A daemon that forwards
to any URL is useful to any page in your browser, not just this one — so the
origin allowlist is the whole security boundary.

It holds because the browser sets `Origin` itself and a page cannot forge it.
A site you happen to visit cannot borrow the bridge to reach your router's admin
page or a service on your network.

Allowed by default: `https://o.eval.blog`, `https://0xcrypto.github.io`, any
loopback origin on any port, and the Tauri webview origins. Everything else gets
a 403 that names the flag you would need.

```sh
nilgai-bridge --allow-origin https://my.own.host    # add one
nilgai-bridge --only-origin  https://my.own.host    # replace the defaults
nilgai-bridge --allow-any-origin                    # development only
```

A request with **no** `Origin` at all is allowed. Those come from non-browser
clients, and anything on your machine that can open a socket could already reach
the same endpoints directly — so refusing them would buy nothing. If that is not
true for you, because the machine is shared, use `--token <secret>`; the app has
a field for it under the address.

`--host 0.0.0.0` binds beyond this machine. Do not do that without `--token`;
the bridge warns you if you try.

### Safari

Chrome and Firefox treat `http://127.0.0.1` as trustworthy, so an HTTPS page may
call it. Safari does not, and blocks it as mixed content — so on Safari the
hosted app cannot reach the bridge no matter how it is configured.

The way out is to stop being cross-origin at all. The bridge will serve the app
itself:

```sh
npm --prefix web run build
nilgai-bridge --ui-dir web/dist
# open http://127.0.0.1:8787/
```

Now the page and the bridge share an origin: no mixed content, and nothing left
for CORS to block.

### Options

```
-p, --port <port>        Port to listen on (default 8787)
    --host <addr>        Address to bind (default 127.0.0.1)
    --allow-origin <o>   Also accept this browser origin (repeatable)
    --only-origin <o>    Accept only the origins given this way (repeatable)
    --allow-any-origin   Accept every origin. Development only
    --token <secret>     Require this token on /proxy
    --ui-dir <dir>       Also serve a built copy of NilgAI UI from here
    --insecure           Do not verify TLS upstream. Local self-signed only
    --connect-timeout <s>  Seconds to wait for a connection (default 30)
-v, --verbose            One line per request
    --install-service    Install and start a login service
    --uninstall-service  Stop and remove it
```

## The app

`npm run dev` starts the web app's Vite server and opens the Tauri window
against it. `npm run build` builds the web app into `web/dist` and bundles it.

The app starts its own copy of the bridge in-process, on an ephemeral loopback
port behind a random token, and hands the page the address through a webview
initialization script:

```js
window.__NILGAI_BRIDGE__ = { url: "http://127.0.0.1:50823", token: "…", source: "app" }
```

The UI picks that up and shows **Settings → CORS bypass** as "Built into this
app" — there is nothing to turn on.

### Why the bridge rather than Tauri's HTTP plugin

The obvious alternative is to route provider calls through Tauri's IPC and a
Rust-side HTTP client. That means a second networking path that only exists in
the app, with its own streaming behaviour to get right and its own failure
modes — and the UI would have to know which of the two it was running on.

Reusing the bridge means the hosted web build, the desktop app and the mobile
app all make the same `fetch` to the same kind of endpoint. There is one
implementation to get right, and `web/` never has to care where it is running.

An initialization script is used rather than a Tauri command because it runs in
the webview's privileged context, so the app's `script-src 'self'`
Content-Security-Policy stays exactly as it is on the web.

## Releasing

Push a tag and `.github/workflows/release.yml` builds everything onto one draft
release: the bridge for four platforms, and the app for six.

```sh
git tag v0.1.0 && git push origin v0.1.0
```

| Artefact | Built on | Notes |
| --- | --- | --- |
| `NilgAI-<tag>-macos-universal.app.tar.gz` | macOS | one binary, Apple Silicon and Intel |
| `NilgAI-<tag>-macos-universal.dmg` | macOS | best effort — see below |
| `NilgAI-<tag>-windows-x86_64-setup.exe` | Windows | NSIS installer |
| `NilgAI-<tag>-linux-x86_64.AppImage` / `.deb` | Linux | |
| `NilgAI-<tag>-android.apk` | Linux | universal, signed |
| `NilgAI-<tag>-ios-unsigned.ipa` | macOS | for sideloading |
| `nilgai-bridge-<tag>-<platform>.tar.gz` | all four | the daemon alone |

The release is left as a **draft** — check the artefacts, then publish.

### iOS is unsigned on purpose

`tauri ios build --no-sign` produces a `Payload/NilgAI.app` with no signature
and no embedded provisioning profile. That is what AltStore, SideStore and
Sideloadly want: they re-sign with the user's own Apple ID. Shipping an IPA
signed with someone else's certificate would be useless to them and would need
a paid developer account to produce.

The job asserts all three properties before uploading, because an IPA that is
subtly wrong still looks like an IPA.

### Android needs a keystore

Tauri emits an *unsigned* APK, and Android refuses to install one, so the job
signs it with `zipalign` + `apksigner` and fails loudly if it cannot. Make a key
once:

```sh
keytool -genkeypair -v -keystore nilgai.jks -alias nilgai \
  -keyalg RSA -keysize 2048 -validity 10000
base64 -i nilgai.jks | pbcopy      # -w0 on Linux
```

Then add four repository secrets:

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | the base64 above |
| `ANDROID_KEYSTORE_PASSWORD` | store password |
| `ANDROID_KEY_ALIAS` | `nilgai` |
| `ANDROID_KEY_PASSWORD` | key password |

Keep that keystore. Android identifies an app by its signing key, so losing it
means every existing install has to be uninstalled before it can be upgraded.

### The macOS .dmg can fail, and that is allowed

Tauri's dmg step drives Finder over AppleScript to lay the disk image window
out, which needs a desktop session. On a runner without one it fails with
`Not authorized to send Apple events to Finder (-1743)`. The `.app.tar.gz` is
built first and is the real deliverable, so the job logs a warning and carries
on rather than losing the whole release to window decoration.

### Nothing is notarised

No paid Apple or Windows certificate is involved, so Gatekeeper and SmartScreen
will both object on first launch. The draft release notes tell people how to get
past it; see them for the exact incantations.

### Mobile projects are generated, not committed

`src-tauri/gen/` is in `.gitignore`, so the Android and iOS jobs run
`tauri android init` / `tauri ios init` before building. Nothing to keep in
sync, and no generated Xcode or Gradle project in review diffs.

## Development

```sh
cargo test --workspace                  # bridge unit tests
cargo run -p nilgai-bridge -- -v        # the daemon, chatty
npm --prefix web run mock               # a fake provider on :8124
```

A useful end-to-end check is a provider that sends *no* CORS headers, since
that is the case the bridge exists for. Point NilgAI UI at one, confirm the
browser refuses it, then turn the bridge on and confirm it streams.

### Updating the UI

`web/` is pinned to a commit. To move it:

```sh
git -C web pull origin main
git add web && git commit -m "Update web to <sha>"
```

## Licence

GPL-3.0-or-later, the same as NilgAI UI — see [LICENSE](LICENSE). You may use,
study, share and modify it; a distributed modification has to carry the same
licence with its source available.
