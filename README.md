# ivxai Chat

A chat client that runs entirely in your browser. No backend, no accounts, no
analytics, no telemetry. Point it at a model on your own machine or bring an API
key — the app talks to that endpoint directly, and your conversations and keys
stay in your browser.

<p align="center">
  <img src="demo.png" alt="ivxai Chat with a new conversation open" width="820">
</p>

<p align="center">
  <a href="https://ai.ivx.run/chat">Try it</a> ·
  <a href="https://github.com/ivxlabs/ivxai-app">Desktop app</a> ·
  <a href="LICENSE">GPL-3.0-or-later</a>
</p>

## Private by default

- **No third-party code at runtime.** Halfmoon CSS and IBM Plex are npm
  dependencies bundled into the build and served from your own origin. No CDNs,
  no Google Fonts, no trackers, no analytics, no telemetry.
- **A Content-Security-Policy that enforces it.** `script-src 'self'` — the page
  cannot execute code from anywhere else, even if something tried.
- **Only the requests you asked for.** Chat completions and model lists, to the
  base URL you configured. Check it in the Network panel.
- **Your data stays put.** Conversations and messages live in IndexedDB. Keys
  live there too, optionally encrypted with a passphrase you choose.

The release build fails CI if a third-party origin appears in the bundle, so
this stays true rather than merely being intended.

## Running it

```sh
npm install
npm run dev        # http://localhost:5173
```

For the real thing, including the service worker and offline mode:

```sh
npm run build      # -> dist/
npm run preview    # http://localhost:4173
```

`dist/` is plain static files with a relative base, so it drops into any host or
subdirectory. Open the built site and choose "Install" / "Add to Home Screen" to
keep it as an app; after the first load it works offline.

## Providers

Open **Settings → Providers**. Ollama and OpenRouter are seeded; add more from
the preset list, or point "Custom OpenAI-compatible" at anything speaking the
OpenAI chat API. Paste a key, then **Fetch models**.

| Provider | Base URL | Key |
| --- | --- | --- |
| Ollama | `http://localhost:11434` | not needed |
| LM Studio | `http://localhost:1234/v1` | not needed |
| llama.cpp | `http://localhost:8080/v1` | not needed |
| OpenRouter | `https://openrouter.ai/api/v1` | openrouter.ai/keys |
| OpenAI | `https://api.openai.com/v1` | required |
| Anthropic | `https://api.anthropic.com` | required |
| Groq · Mistral · Together · DeepSeek | see presets | required |

Endpoints with no `/models` route are fine: the model picker and **Default
model** both offer **Type a model name**, and hand-typed names are remembered
per provider.

## CORS

The provider has to allow browser calls. Most hosted ones do. Two need a nudge:

- **Ollama** refuses cross-origin requests by default — start it with your
  origin allowed: `OLLAMA_ORIGINS='http://localhost:5173' ollama serve`
- **Anthropic** needs an opt-in header for direct browser use, which the app
  sends for you. A key used from a browser is visible to anyone using that
  browser.

**Settings → CORS bypass** is the other way round: a small daemon on your
machine forwards the call and answers with the headers the browser wants.

```sh
ivx-bridge                 # listens on 127.0.0.1:8787
```

Then **Look for the bridge**. It is off until you turn it on, keeps nothing, and
only accepts pages from an origin allowlist, so a site you happen to visit
cannot use it to reach your network. The daemon and the desktop app live in
[ivxai-app](https://github.com/ivxlabs/ivxai-app) — the app carries the same
bridge inside it, with nothing to set up.

## Keys and encryption

By default keys sit in IndexedDB in the clear, like every other web app's data.
**Settings → Privacy & data → Encrypt API keys** wraps them in AES-GCM under a
key derived from your passphrase (PBKDF2-SHA256, 310 000 iterations), held in
memory only — so you unlock once per session and can re-lock from the sidebar.
There is no recovery path: lose the passphrase, lose the keys.

## What else is in it

- **Per-chat settings**: system prompt, temperature, max tokens, history depth.
- **Message actions**: copy, edit and re-run from that point, retry, delete.
- **Chat actions**: rename, duplicate, export as JSON or Markdown, delete.
- **Backup**: export everything to JSON, keys included only if you tick the box.
- **Search** across chat titles and message text.
- **Erase everything** wipes IndexedDB, preferences and the offline cache.
- **Scan for local servers** probes the usual ports and adds whatever answers.

## Deploying

`.github/workflows/deploy.yml` builds every push and pull request, and publishes
to GitHub Pages from `main`. The only setup is **Settings → Pages → Build and
deployment → Source: GitHub Actions**.

## Contributing

The project layout, the service worker, the theme and the traps worth knowing
before changing CSS are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Supporting it

ivxai Chat is part of [ivx](https://github.com/ivxlabs)' effort to strip
trackers and advertising out of privacy-critical infrastructure, and to make
open-weight models a practical default. No ads, no telemetry, no paid tier.

- [Sponsor the project](https://github.com/sponsors/0xcrypto)
- [Star it on GitHub](https://github.com/ivxlabs/chat) — it is how other people find it

## Licence

Free software under the **GNU GPL v3.0 or later** — see [LICENSE](LICENSE). You
may use, study, share and modify it; a distributed modification has to carry the
same licence with its source available.

Bundled dependencies keep their own terms: Halfmoon CSS is MIT, © 2023 Tahmid
Khan; IBM Plex is SIL OFL, © IBM; Vite is MIT.
