# NilgAI UI

A chat client that runs entirely in your browser. No backend, no accounts, no
analytics. Point it at a model running on your own machine, or bring an API key
— either way the app talks to that endpoint directly, and conversations and
keys stay in your browser.

Built with Vite. Halfmoon CSS and IBM Plex, both bundled from npm and served
from your own origin.

## What makes it private

- **No third-party code at runtime.** Halfmoon and IBM Plex are npm
  dependencies bundled into the build and served from your origin. No CDNs, no
  Google Fonts, no trackers, no analytics, no telemetry.
- **A Content-Security-Policy that enforces it.** `script-src 'self'` — the page
  cannot execute code from anywhere else, even if something tried.
- **The only outbound requests are yours.** Chat completions and model lists, to
  the base URL you configured. You can verify this in the Network panel.
- **Your data stays put.** Conversations and messages live in IndexedDB; keys
  live there too, optionally encrypted with a passphrase you choose.

## Running it

```sh
npm install
npm run dev        # http://localhost:5173
```

For the real thing, including the service worker:

```sh
npm run build      # -> dist/
npm run preview    # http://localhost:4173
```

`dist/` is plain static files with a relative base, so it drops into any host or
subdirectory. `file://` will not work: service workers, and therefore offline
mode, need `http://localhost` or HTTPS.

The service worker is only registered in production builds — a cache in front of
the dev server causes more confusion than it saves.

To install it as an app, open the built site and use "Install" / "Add to Home
Screen". After the first load it works offline; only the model calls need the
network.

## Deploying

`.github/workflows/deploy.yml` builds on every push and pull request, and
publishes to GitHub Pages from `main`.

One-time setup: **Settings → Pages → Build and deployment → Source: GitHub
Actions**. Nothing else to configure — `base: './'` means the build works from
a repository subpath, so `https://0xcrypto.github.io/nilgai/` needs no special
casing, and the service worker scope and manifest `start_url` follow it.

The build job fails the run on two things that would otherwise ship quietly:

- `dist/sw.js` still containing `__PRECACHE_MANIFEST__` — meaning the precache
  plugin stopped running and the app would cache nothing offline.
- any CDN origin appearing in the bundle, which would break the promise that
  nothing third-party loads at runtime.

To check a build locally the way Pages serves it:

```sh
npm run build
mkdir -p /tmp/pages/nilgai && cp -R dist/* /tmp/pages/nilgai/
cd /tmp/pages && python3 -m http.server 8125
# http://localhost:8125/nilgai/
```

## Setting up a provider

Open **Settings → Providers**. Two are seeded for you (Ollama and OpenRouter);
add more from the preset list, or point "Custom OpenAI-compatible" at anything
that speaks the OpenAI chat API.

| Provider | Base URL | Key |
| --- | --- | --- |
| Ollama | `http://localhost:11434` | not needed |
| OpenRouter | `https://openrouter.ai/api/v1` | openrouter.ai/keys |
| OpenAI | `https://api.openai.com/v1` | required |
| Anthropic | `https://api.anthropic.com` | required |
| Groq / Mistral / Together / DeepSeek | see presets | required |
| LM Studio | `http://localhost:1234/v1` | not needed |
| llama.cpp | `http://localhost:8080/v1` | not needed |

Paste the key, hit **Save**, then **Fetch models** to populate the model picker.

### CORS

The provider has to allow browser calls. OpenRouter, OpenAI, Groq and friends
do. Two cases need a nudge:

- **Ollama** refuses cross-origin requests by default. Start it with your app's
  origin allowed:

  ```sh
  OLLAMA_ORIGINS='http://localhost:5173' ollama serve   # or your built origin
  ```

  **Settings → Providers → Scan for local servers** probes the usual ports
  (Ollama, LM Studio, llama.cpp, Jan, vLLM, LocalAI, text-generation-webui) and
  adds whatever answers. A runtime that is running but refuses browser origins
  will not answer, so a miss usually means CORS rather than "not installed".

- **Anthropic** needs an opt-in header for direct browser use; the app sends
  `anthropic-dangerous-direct-browser-access` for you. Note that any key used
  from a browser is visible to anyone with access to that browser.

## Keys and encryption

By default keys sit in IndexedDB in the clear — the same place every web app
keeps its data, readable by anyone who can use your unlocked machine.

**Settings → Privacy & data → Encrypt API keys** wraps them in AES-GCM with a
key derived from your passphrase (PBKDF2-SHA256, 310 000 iterations). The
derived key is held in memory only, so you unlock once per session and can
re-lock from the sidebar. There is no recovery path: lose the passphrase, lose
the keys.

## Everything else

- **Per-chat settings** (the ⚙ button): system prompt, temperature, max tokens,
  and how many past messages to send. Tick the box to make them the default for
  new chats.
- **Message actions** on hover: copy, edit (re-runs from that point), retry,
  delete.
- **Chat actions** (⋯): rename, duplicate, export as JSON or Markdown, clear,
  delete.
- **Backup**: export everything to a JSON file; API keys are included only if
  you tick the box. Import merges a file back in.
- **Erase everything** wipes IndexedDB, preferences and the offline cache.
- **Search** matches chat titles and message text.
- **Shortcuts**: `Enter` sends (configurable), `Shift+Enter` for a newline,
  `Esc` closes the drawer or pops a sheet screen.
- **Local runtimes** are seeded by default (Ollama, LM Studio) and marked
  `local` in settings.

## Layout

```
index.html                entry document and the CSP
vite.config.js            build config + the service-worker precache plugin
src/main.js               chat shell: drawer, thread, composer, model picker
src/settings.js           settings as a stack of pushed screens
src/ui.js                 DOM helpers + the bottom-sheet navigation stack
src/store.js              IndexedDB: conversations, messages, key/value
src/vault.js              API key storage and the optional passphrase vault
src/providers.js          OpenAI / Anthropic / Ollama adapters, SSE + ndjson
src/markdown.js           escape-first Markdown renderer (no third-party lib)
src/styles/theme.css      IBM Plex, the neutral palette, the 44px touch scale
src/styles/app.css        the app shell: drawer, thread, composer, sheets
public/sw.js              offline shell; never touches provider traffic
public/manifest.webmanifest, public/icons/
tools/make-icons.mjs      regenerates the PNG icons
tools/mock-provider.mjs   a fake endpoint for trying the app without a key
```

## Shape of the UI

It is a mobile app that happens to run at any width. One column; the reading
column widens on a large screen but the interaction model never changes.

- **Top bar** is only ☰, the chat title, ＋ and ⋯. Nothing else lives up there.
- **Navigation** is a drawer at every width, not a sidebar that appears on desktop.
- **Every panel is a bottom sheet** — settings, the model picker, chat actions,
  confirmations, prompts. Screens push and pop on one stack (`src/ui.js`), so
  there is never more than one layer of chrome on screen.
- **Settings is a grouped list**, iOS-style: a row pushes a detail screen, and
  fields save on change rather than behind a Save button.
- **The model and provider** collapse into one chip above the composer. Tapping
  it opens a picker grouped by provider.
- **Messages** are plain: your turn is a right-aligned bubble, the assistant's
  is unadorned prose. Model name, token count and the Copy/Retry/Edit/Delete
  actions stay hidden until you tap a message.

### About the service worker

`public/sw.js` ships with `__PRECACHE_MANIFEST__` and `__CACHE_VERSION__`
placeholders. A ~30-line plugin in `vite.config.js` replaces them with the real
hashed asset list after each build, so the cache name changes whenever any asset
does.

This is deliberately not `vite-plugin-pwa`/Workbox: the premise of the app is
that every line of shipped JavaScript is auditable and ours, and a precache
manifest is just a list of strings.

One subtlety worth knowing if you touch it: Vite tags its JS and CSS with
`crossorigin`, so the browser sends an `Origin` header for them and most static
hosts reply `Vary: Origin`. Requests made during install carry no `Origin`, so
cache lookups need `ignoreVary: true` or they silently miss.

### Developing

```sh
npm run mock     # fake OpenAI-compatible API on :8124
npm run icons    # only if the artwork changes
```

Add `http://localhost:8124/v1` as a custom provider to exercise streaming,
Markdown rendering and error handling without spending anything.

### Control sizing and class names

Halfmoon's default control is 30px, which is a mouse target. `theme.css` lifts
everything interactive to 44px and inputs to `1rem` — the latter also stops iOS
Safari zooming the viewport when a field takes focus. Halfmoon supplies the
tokens, form controls, switches and buttons; the shell structures (drawer,
sheet, grouped rows) are the app's own CSS.

One trap worth knowing: **Halfmoon is Bootstrap-compatible, so its class
namespace is Bootstrap's.** `.row` and `.toast` are real Bootstrap components,
and naming app classes that way silently inherits `flex-wrap: wrap`, negative
gutters or `display: none`. The app's list rows are `.item` and its toasts are
`.snack` for exactly this reason. To check a new class name:

```sh
node -e "const fs=require('fs');const hm=fs.readFileSync('node_modules/halfmoon/css/halfmoon.min.css','utf8');console.log(new RegExp('\\.'+process.argv[1]+'[,{ :]').test(hm)?'COLLIDES':'free')" my-class
```

### Theming

`src/styles/theme.css` holds the neutral ramp (`--n-50` … `--n-950`). Halfmoon
generates every shade from a few hue/saturation knobs, so the theme zeroes those
rather than overriding hundreds of derived variables. The one exception to the
monochrome rule is a muted red for destructive actions — without it "Erase
everything" looks identical to "Export".

Halfmoon CSS is MIT licensed, © 2023 Tahmid Khan. IBM Plex is SIL OFL, © IBM.
