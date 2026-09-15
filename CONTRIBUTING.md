# Contributing

```sh
npm install
npm run dev      # http://localhost:5173
npm run mock     # fake OpenAI-compatible API on :8124
npm run icons    # only if the artwork changes
```

Add `http://localhost:8124/v1` as a custom provider to exercise streaming,
Markdown rendering and error handling without spending anything.

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
src/bridge.js             the optional CORS bridge: probing it, routing via it
src/markdown.js           escape-first Markdown renderer (no third-party lib)
src/styles/theme.css      IBM Plex, the neutral palette, the 44px touch scale
src/styles/app.css        the app shell: drawer, thread, composer, sheets
public/sw.js              offline shell; never touches provider traffic
tools/make-icons.mjs      regenerates the PNG icons
tools/mock-provider.mjs   a fake endpoint for trying the app without a key
```

## Shape of the UI

It is a mobile app that happens to run at any width. One column; the reading
column widens on a large screen but the interaction model never changes.

- **Top bar** is only ☰, the chat title, ＋ and ⋯.
- **Navigation** is a drawer at every width, not a sidebar that appears on desktop.
- **Every panel is a bottom sheet** — settings, the model picker, chat actions,
  confirmations, prompts. Screens push and pop on one stack (`src/ui.js`), so
  there is never more than one layer of chrome on screen.
- **Settings is a grouped list**, iOS-style: a row pushes a detail screen, and
  fields save on change rather than behind a Save button.
- **Messages** are plain: your turn is a right-aligned bubble, the assistant's is
  unadorned prose, and the per-message actions stay hidden until you tap one.

## The service worker

`public/sw.js` ships with `__PRECACHE_MANIFEST__` and `__CACHE_VERSION__`
placeholders. A ~30-line plugin in `vite.config.js` replaces them with the real
hashed asset list after each build, so the cache name changes whenever any asset
does. The deploy workflow fails the build if those placeholders survive.

This is deliberately not `vite-plugin-pwa`/Workbox: the premise of the app is
that every line of shipped JavaScript is auditable and ours, and a precache
manifest is just a list of strings.

One subtlety if you touch it: Vite tags its JS and CSS with `crossorigin`, so
the browser sends an `Origin` header for them and most static hosts reply
`Vary: Origin`. Requests made during install carry no `Origin`, so cache lookups
need `ignoreVary: true` or they silently miss.

To check a build the way Pages serves it, from a subpath:

```sh
npm run build
mkdir -p /tmp/pages/chat && cp -R dist/* /tmp/pages/chat/
cd /tmp/pages && python3 -m http.server 8125
# http://localhost:8125/chat/
```

## CSS

Halfmoon's default control is 30px, which is a mouse target. `theme.css` lifts
everything interactive to 44px and inputs to `1rem` — the latter also stops iOS
Safari zooming the viewport when a field takes focus. Halfmoon supplies the
tokens, form controls, switches and buttons; the shell structures (drawer,
sheet, grouped rows) are the app's own CSS.

**Halfmoon is Bootstrap-compatible, so its class namespace is Bootstrap's.**
`.row` and `.toast` are real Bootstrap components, and naming app classes that
way silently inherits `flex-wrap: wrap`, negative gutters or `display: none`.
The app's list rows are `.item` and its toasts are `.snack` for exactly this
reason. To check a new class name:

```sh
node -e "const fs=require('fs');const hm=fs.readFileSync('node_modules/halfmoon/css/halfmoon.min.css','utf8');console.log(new RegExp('\\.'+process.argv[1]+'[,{ :]').test(hm)?'COLLIDES':'free')" my-class
```

`src/styles/theme.css` holds the neutral ramp (`--n-50` … `--n-950`). Halfmoon
generates every shade from a few hue/saturation knobs, so the theme zeroes those
rather than overriding hundreds of derived variables. The one exception to the
monochrome rule is a muted red for destructive actions — without it "Erase
everything" looks identical to "Export".

## Before opening a pull request

Keep the promise the README makes: no third-party origin may appear in the
build, and `script-src 'self'` stays as it is. The deploy workflow checks both.
