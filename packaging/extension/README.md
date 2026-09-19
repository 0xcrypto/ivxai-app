# The browser extension

The same chat app, packaged as an extension for Chrome, Firefox and Safari.

Nothing here is a fork. `scripts/extension-build.mjs` takes the ordinary web
build out of `web/dist`, puts a manifest around it, and writes one directory
per browser. The app notices where it is running by itself — `EXTENSION` in
`web/src/bridge.js` — and adjusts.

## Why an extension at all

The bridge exists because a web page may not call an endpoint that refuses
browser origins, and may not call plain `http` on loopback from an `https`
page. Neither is a fault in Ollama, or in llama.cpp, or in a company proxy;
both are rules the browser applies to pages.

An extension page is not a page in that sense. It can carry host permissions,
and with one for a given host it calls that host directly, CORS or no CORS. The
bridge is therefore off by default here, and a normal install never needs it
installed or left running.

Off by default, not gone. Two things still reach past it:

- A local MCP server means starting a program on this machine, which no
  extension may do. That is the bridge's job either way.
- An endpoint may refuse the extension by name rather than by CORS — see
  *Not sending an Origin* below — and if the rule that prevents that is not in
  force, every message fails with a 403. The bridge goes around it, so an
  enabled bridge here carries provider calls too rather than being ignored.

Which is why Settings → CORS bypass is still there, still works, and does not
claim to be unnecessary.

## Permissions

Nothing broad is asked for on install. `host_permissions` is empty and
`optional_host_permissions` is `<all_urls>`, so the browser shows no "read and
change all your data on all websites" on the way in, and the extension starts
out reaching only what CORS already lets any page reach.

That is further than it sounds. A provider that answers with CORS headers —
OpenAI, Anthropic, OpenRouter, Groq, the HuggingFace downloads WebLLM makes,
the bridge itself — needs no permission at all. Host access buys something only
where the endpoint refuses browser origins: Ollama, LM Studio, llama.cpp, a
server someone runs themselves. `web/src/host-access.js` asks for those one host
at a time, on the click that introduces them — Settings → Providers → Allow
access, or the row above the local scan.

One thing to know about the granularity: a match pattern carries no port, so
allowing `http://localhost:11434` allows every port on `localhost`. The UI says
so rather than implying otherwise.

| permission | what for |
| --- | --- |
| `optional_host_permissions: <all_urls>` | the pool the per-host grants come out of; the endpoint is the user's to choose and cannot be enumerated here |
| `sidePanel` (Chrome) | the app's only UI; Firefox uses `sidebar_action`, which needs none, and Safari has neither |
| `declarativeNetRequestWithHostAccess` (Chrome, Safari) | one rule, removing `Origin` from this extension's own requests — see below. The `WithHostAccess` spelling modifies only hosts already granted, and carries no install warning of its own |
| `webRequest`, `webRequestBlocking` (Firefox) | the same rule, the only way Firefox will apply it to an extension's own requests |

`npm run ext:test` checks the model from both ends: that a CORS-less endpoint is
out of reach before the grant, and in reach after it. Firefox goes through the
real `permissions.request()`, off a click the browser counts as user input.
Chrome cannot — its optional-permission prompt is a browser dialog no script can
answer, and the CDP Extensions domain grants nothing — so there the granted
state is reproduced by declaring the host and reloading. What that leaves
untested on Chrome is Chrome's own dialog.

## Building

```sh
npm run ext:build              # all three, into build/
npm run ext:build chrome       # just one
npm run ext:test               # install into real Chrome and Firefox, check it
npm run ext:safari             # generate and build the Safari app
```

`build/` is disposable and git-ignores itself; so does the Xcode project under
`packaging/safari`. Both are regenerated from `web/dist` every time.

## Publishing

Tagging a release builds the Chrome and Firefox zips, attaches both to the
GitHub release, and uploads the Chrome one to the Web Store and submits it for
review. Safari is not in that job: what it installs is an app, and only Xcode on
a Mac can produce one.

Submitting is not going live. The store reviews it, in anywhere from an hour to
a week, and decides.

### The first version goes up by hand

The API replaces the draft of an item that already exists; it cannot write a
listing. So upload `ivxai-chat-<version>-chrome.zip` at
[the developer dashboard](https://chrome.google.com/webstore/devconsole) once,
fill in the description, screenshots and privacy answers, and publish it. The
32 letters in that item's dashboard URL are its id, and every later version is
the workflow's job.

### Setting up the credentials, once

In [console.cloud.google.com](https://console.cloud.google.com), on any project:

1. **APIs & Services → Library** → enable **Chrome Web Store API**.
2. **OAuth consent screen** → External → fill the required fields →
   **Publish app**.
3. **Credentials → Create credentials → OAuth client ID → Desktop app.**

Step 2 is the one that bites. A consent screen left in *Testing* issues refresh
tokens that stop working after seven days, so the release succeeds now and fails
a fortnight later saying only `invalid_grant`. Publish it and the token keeps.

Then, locally:

```sh
WEBSTORE_CLIENT_ID=… WEBSTORE_CLIENT_SECRET=… npm run ext:auth
```

which opens the consent page and prints what to put in **Settings → Secrets and
variables → Actions**:

| secret | |
| --- | --- |
| `WEBSTORE_CLIENT_ID` | from step 3 |
| `WEBSTORE_CLIENT_SECRET` | from step 3 |
| `WEBSTORE_REFRESH_TOKEN` | printed by `npm run ext:auth` |
| `WEBSTORE_ITEM_ID` | the 32 letters in the dashboard URL |

The refresh token can publish to the store account on its own. Treat it as the
credential it is.

Without `WEBSTORE_ITEM_ID` the publish step is skipped and the release still
finishes with both zips attached, so a fork or a clone is never broken by
secrets it does not have.

### Publishing by hand

```sh
npm run ext:publish -- packaging/extension/build/ivxai-chat-0.2.2-chrome.zip
```

Uploads as a draft. Add `--publish` to submit it, or
`--publish --target trustedTesters` to send it to testers rather than everyone.
The same four environment variables apply.

Firefox is attached to the release but not published: AMO wants its own
credentials and its own review, and nobody has asked for that yet.

## Installing it, by hand

**Chrome** — `chrome://extensions`, turn on Developer mode, *Load unpacked*,
choose `packaging/extension/build/chrome`.

Chrome no longer accepts `--load-extension` on the command line ("not allowed
in Google Chrome"), so this is the only way in by hand. `npm run ext:test`
gets around it with `Extensions.loadUnpacked` over the DevTools protocol.

**Firefox** — `about:debugging#/runtime/this-firefox`, *Load Temporary
Add-on*, choose `manifest.json` inside `packaging/extension/build/firefox`.
Temporary means it goes away when Firefox closes; a permanent install needs
the add-on signed by Mozilla.

**Safari** — Safari does not install a folder, it installs an app, and the
extension rides inside it:

```sh
npm run ext:safari
open packaging/safari/build/Build/Products/Release/ivxai-chat.app
```

Then, in Safari: *Settings → Extensions* and tick it. A build signed only
ad-hoc — which is what the command above produces, because we do not pay Apple
for a certificate — also needs *Develop → Allow Unsigned Extensions*, which
Safari forgets every time it quits.

## What the manifests ask for

`<all_urls>`, and per browser one permission for dropping the `Origin` header
(below) plus `sidePanel` on Chrome. Nothing else: no `tabs`, no `storage`, no
content scripts, no `web_accessible_resources` — the extension never touches a
page you visit, because it never runs anywhere except its own panel.

`<all_urls>` is broad, and the narrower thing does not exist: the endpoint is
whichever one you typed. A provider you self-host, a runtime on a port only
you use, a gateway inside a company network — none of that can be listed ahead
of time, and an extension cannot widen its own host permissions later without
asking again from scratch.

## Where it opens

In a side panel, beside the page you are reading — which is three different
APIs with nothing in common but the idea.

| | how |
| --- | --- |
| Chrome | `side_panel`, plus the `sidePanel` permission. `setPanelBehavior({ openPanelOnActionClick: true })` makes the toolbar button open it, after which the click never reaches the extension. |
| Firefox | `sidebar_action`, unrelated and needing no permission. Firefox lists it in the sidebar menu itself; the toolbar button calls `sidebarAction.toggle()`. |
| Safari | No sidebar exists. `safari-web-extension-converter` rejects `sidebar_action`, `side_panel` and `sidePanel` alike, so the app opens in a tab. |

A popup would have been the closer shape for Safari, and worse: it closes the
moment you click away, which for a window you type into loses the message.

The app is the same page either way, and its narrow layout — the one phones
get — is what a panel shows.

## Not sending an Origin

Getting past CORS is only half of it, and the quieter half is the `Origin`
header. A browser attaches one to every cross-origin POST, from an extension
page as readily as from a web page, and a runtime that vets origins — Ollama
checking `OLLAMA_ORIGINS` — answers 403. Nothing is blocked by the browser
there: the request arrives and the server turns it down.

It hides well. A GET carries no Origin, so model lists load and the extension
looks like it works, right until the first message is sent.

So the extension removes the header from its own calls, which puts it where a
native client already is: `curl` and Ollama's own CLI send no Origin and are
trusted for it. The header exists to tell a server that some *other* website
caused this request. Nothing caused this one — the person installed the app and
typed the address.

| | how |
| --- | --- |
| Chrome, Safari | `declarativeNetRequest`, a session rule matching `initiatorDomains: [runtime.id]` |
| Firefox | `webRequest` + `webRequestBlocking`, matching on `originUrl`. Firefox has declarativeNetRequest but does not apply it to an extension's own requests; Safari is the mirror image and rejects `webRequestBlocking`. |

The scoping is the part that matters. Stripping `Origin` browser-wide would
take a real protection away from every site you visit, so both rules match only
requests this extension made. `npm run ext:test` checks that from both ends: the
extension's Origin is gone, and an ordinary page's is still there.

The rule is registered when `background.js` runs, and nothing guarantees that it
has: an MV3 background script starts for an event, and opening the side panel is
not one of them. A build loaded before this rule existed has the same problem
until the extension is reloaded by hand. Either way every POST fails with a 403
that reads like a rejected API key — so the app does not assume. At boot it asks
the background script (`ivx:origin-strip`) whether the header is being dropped,
which both answers the question and, being an event, starts the script that was
not running. The answer is what the 403 message and the CORS bypass screen are
written from.

Safari is the gap. It takes the same rule Chrome does, but nothing can drive
Safari to confirm it honours a `modifyHeaders` action — so on Safari, treat this
as untested, and expect an origin-checking endpoint to still want the bridge.

## What else differs per browser

|  | why |
| --- | --- |
| `background.service_worker` | Chrome and Safari |
| `background.scripts` | Firefox, which has no extension service worker |
| `browser_specific_settings.gecko.id` | Firefox wants a stable add-on id |
