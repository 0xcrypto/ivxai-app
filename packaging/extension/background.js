// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* Opening the app, and nothing else.

   The extension packages the whole chat app and runs it as an ordinary page on
   the extension's own origin. That origin carries the manifest's host
   permissions, so the page reaches every provider itself — there is no
   proxying to do here, no messages to relay and no state worth keeping.

   Where it opens is the only thing that differs between browsers, and all
   three disagree:

     Chrome    `sidePanel`, a panel the browser owns. Asking it to open on the
               toolbar click means the click never reaches us — which is why
               the listener below is not Chrome's path.
     Firefox   `sidebar_action`, an unrelated API for the same idea. Firefox
               puts it in the sidebar menu on its own; the toolbar button
               toggles it from here.
     Safari    Neither exists. The converter says so outright, so the app opens
               in a tab there. A popup would be closer in shape and worse in
               practice: it closes the moment you click away, which for a
               window you type into is the wrong trade.

   Written for both dialects: Chrome and Safari run this as a service worker,
   Firefox as an event page. Neither keeps it alive, so nothing here may assume
   it survives. */

const api = globalThis.browser ?? globalThis.chrome;

/* ── not sending an Origin ─────────────────────────────────────

   A browser attaches `Origin` to every cross-origin POST, and an extension
   page is no exception: ours goes out as `Origin: chrome-extension://<id>`.
   Plenty of local runtimes check that header against a list they were given —
   Ollama's OLLAMA_ORIGINS is the one people meet — and answer 403 to anything
   not on it. The browser permits the request; the server refuses it. So the
   call still fails, still needs the bridge, and fails in a way that reads like
   a rejected API key.

   Which misses what the header is for. `Origin` exists so a server can tell
   that some *other* website told a browser to make this request. Nothing told
   this extension anything: it is the client, the person installed it, and they
   typed the address themselves. A native client in the same position — curl,
   Ollama's own CLI — sends no Origin at all, and is trusted for it. So this
   removes ours, and the endpoint sees what it would have seen from any program
   on the machine.

   The scoping is the part that has to be right. A rule that stripped Origin
   from every request the browser makes would take a real protection away from
   every site the person visits, so both branches below match on the request
   having come from this extension and nothing else. Both are verified against
   a control in scripts/extension-test.mjs: an ordinary page's Origin survives.

   Two branches because no API does this everywhere. Chrome and Safari get
   declarativeNetRequest; Firefox has it too but does not apply it to an
   extension's own requests, and still allows blocking webRequest, which Safari
   in turn does not support. The manifest grants one permission or the other,
   so the feature check below picks the branch that was provisioned.

   And the app is told the answer rather than left to assume it. None of this
   runs unless this script does, and nothing guarantees that it has: an MV3
   background script is started for an event, the side panel opening is not one,
   and a rule that was never registered fails exactly like a rejected key. So
   the result is kept as a promise, the app asks for it at boot, and asking is
   itself what starts this script if it was not running. */

const STRIP_ORIGIN_RULE = 1;

/** Resolves to whether this browser is now dropping our `Origin`. */
const originStripped = stripOrigin();

async function stripOrigin() {
  if (api.declarativeNetRequest?.updateSessionRules) {
    // Session rules, not static ones: `initiatorDomains` needs the extension
    // id, which is only knowable at runtime.
    try {
      await api.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [STRIP_ORIGIN_RULE],
        addRules: [{
          id: STRIP_ORIGIN_RULE,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'origin', operation: 'remove' }],
          },
          condition: {
            initiatorDomains: [api.runtime.id],
            resourceTypes: ['xmlhttprequest'],
          },
        }],
      });
      return true;
    } catch {
      return false;   // provider calls still work, minus origin-checking ones
    }
  }

  // Registered synchronously — nothing above this point awaits on the branch
  // that gets here — so the listener is in place before the app can send a
  // request past it.
  if (api.webRequest?.onBeforeSendHeaders) {
    const SELF = api.runtime.getURL('');
    api.webRequest.onBeforeSendHeaders.addListener(
      details => {
        // originUrl is the page that made the call. Anything that is not one
        // of ours is left exactly as it was.
        if (!details.originUrl?.startsWith(SELF)) return {};
        return {
          requestHeaders: details.requestHeaders.filter(h => h.name.toLowerCase() !== 'origin'),
        };
      },
      { urls: ['<all_urls>'] },
      ['blocking', 'requestHeaders'],
    );
    return true;
  }

  return false;
}

/* The app's one question, answered once the rule above has actually landed.
   `true` here is the app's licence to call a provider directly; `false`, or no
   answer at all, is what sends it to the bridge instead of into a 403. */
api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'ivx:origin-strip') return false;
  originStripped.then(stripped => sendResponse({ stripped }));
  return true;   // the answer comes later
});

/* Chrome only. Set at every worker start rather than on install: the setting
   persists, but re-asserting it is free and survives a profile that has lost
   it. After this the toolbar button opens the panel directly and
   `action.onClicked` never fires here. */
api.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true })
  .catch(() => { /* older Chrome without the API; the tab fallback covers it */ });

/* Safari's fallback only. Remembered so a second click returns to the app
   instead of opening a second copy of it — two tabs share one IndexedDB, and
   watching the other tab's chats appear underneath you is not a good
   introduction to the thing.

   Deliberately not persisted. When the worker is torn down this is forgotten
   and the next click opens a fresh tab, which costs one spare tab. The
   alternative is the "tabs" permission, which the browser shows on install as
   "read your browsing history" — too much to ask for a convenience this
   small. */
let openTabId = null;

/** True when the app was already open and has now been brought to the front. */
async function focusExisting() {
  if (openTabId === null) return false;
  try {
    const tab = await api.tabs.get(openTabId);
    await api.tabs.update(tab.id, { active: true });
    if (tab.windowId !== undefined) await api.windows.update(tab.windowId, { focused: true });
    return true;
  } catch {
    // Closed, or in a window that has since gone away.
    openTabId = null;
    return false;
  }
}

api.action.onClicked.addListener(async () => {
  // Firefox: toggle the sidebar. Allowed here because a toolbar click is the
  // user gesture the API requires.
  if (api.sidebarAction?.toggle) {
    await api.sidebarAction.toggle();
    return;
  }

  // Safari: no sidebar of any kind, so the app gets a tab.
  if (await focusExisting()) return;
  const tab = await api.tabs.create({ url: api.runtime.getURL('index.html') });
  openTabId = tab.id;
});

api.tabs.onRemoved.addListener(id => {
  if (id === openTabId) openTabId = null;
});

/* ── page tools ────────────────────────────────────────────────

   Select text on a page and a small bar offers to summarize it, translate it
   or put a question about it to an agent; focus a text field and a chip offers
   to write into it. content.js is what draws those; this is what carries them
   to the app and the app's answer back.

   The part worth reading twice is that content.js is *not* in the manifest.
   A content script declared there comes with host permissions declared there,
   and for a tool that could be used on any site that reads, on install, as
   "read and change all your data on all websites" — the sentence this
   extension has gone to some length not to say, and does not mean: page tools
   are off until a person turns them on, and reach one site at a time after
   that. So the script is registered at runtime for the sites they allowed,
   which is a permission the browser asks about at the moment there is a site
   to name. See web/src/page-tools.js for the end that asks.

   Three hops, because none of the three parties can reach the others:

     page → here   a click in content.js, which is also the user gesture that
                   lets the panel be opened at all.
     here → app    the request is queued and the app is nudged. Queued rather
                   than sent, because the click that opens the panel is also
                   the click whose request it carries, and the panel is not
                   loaded yet; the app claims the queue when it boots and on
                   every nudge after.
     app → page    one message, `ivx:page-write`, carrying the text a `<write>`
                   tool call produced. The app never writes what the model
                   *said* — only what it asked for through the tool. */

const SITES_KEY = 'ivx:page-sites';    // match patterns page tools may run on
const AGENTS_KEY = 'ivx:agents';       // names for content.js's agent picker
const QUEUE_KEY = 'ivx:page-queue';    // requests the app has not claimed yet
const SCRIPT_ID = 'ivx-page-tools';

/* Session storage where there is one: a queued request is about a click that
   just happened and means nothing tomorrow. Not every browser this ships to
   has it, and `local` holds the site list and the agent names in either case —
   those are settings, and are meant to outlive the session. */
const session = api.storage?.session ?? api.storage?.local ?? null;
const local = api.storage?.local ?? null;

const read = async (store, key, fallback) => {
  try {
    return (await store?.get(key))?.[key] ?? fallback;
  } catch {
    return fallback;
  }
};

/**
 * Register content.js for the sites page tools are allowed on — and only for
 * those.
 *
 * Called at every start (a registration does survive a worker restart, but a
 * profile that has lost it is cheaper to fix than to diagnose), and again
 * whenever the site list or the granted permissions change. The two have to
 * agree: a pattern in the list without the permission behind it is refused by
 * `registerContentScripts`, which would take the whole registration down with
 * it, so what is granted is what is registered.
 */
async function syncPageTools() {
  if (!api.scripting?.registerContentScripts) return;

  const wanted = await read(local, SITES_KEY, []);
  const allowed = [];
  for (const pattern of wanted) {
    try {
      if (await api.permissions.contains({ origins: [pattern] })) allowed.push(pattern);
    } catch {
      /* a pattern the browser will not even consider; leave it out */
    }
  }

  try {
    const existing = await api.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
    if (existing.length) await api.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  } catch {
    /* nothing registered, which is the state the next lines want anyway */
  }
  if (!allowed.length) return;

  try {
    await api.scripting.registerContentScripts([{
      id: SCRIPT_ID,
      js: ['content.js'],
      matches: allowed,
      // An editor's field is as often in an iframe as in the page itself, and
      // a selection belongs to one frame either way — so every frame gets the
      // script and the frame that owns the thing is the one that reacts.
      allFrames: true,
      runAt: 'document_idle',
      persistAcrossSessions: true,
    }]);
  } catch {
    return;   // nothing registered; the app's settings screen says page tools are off
  }

  /* A registration only reaches pages loaded after it, which would mean
     allowing a site and then having to reload the tab you allowed it for.
     Injecting into what is already open closes that gap; content.js guards
     against running twice in one frame, so a frame that raced the two and got
     both is no worse off than one that got either. */
  try {
    for (const tab of await api.tabs.query({ url: allowed })) {
      if (tab.id === undefined) continue;
      api.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['content.js'],
      }).catch(() => { /* a frame that refuses injection, or already has it */ });
    }
  } catch {
    /* no tabs to look at */
  }
}

syncPageTools();
api.permissions.onAdded?.addListener(syncPageTools);
api.permissions.onRemoved?.addListener(syncPageTools);
api.storage?.onChanged?.addListener((changes, area) => {
  if (area === 'local' && SITES_KEY in changes) syncPageTools();
});

/**
 * Open the app, wherever this browser keeps it.
 *
 * The same three-way split as the toolbar click above, and for the same
 * reasons — with one extra constraint: both panel APIs require a user gesture,
 * and the gesture here is the click in the page that sent us this message. It
 * survives exactly as long as nothing is awaited before the call, which is why
 * this runs before the request is queued rather than after.
 */
function openApp(tabId) {
  if (api.sidePanel?.open) {
    return api.sidePanel.open(tabId === undefined ? {} : { tabId })
      .catch(() => openTab());
  }
  if (api.sidebarAction?.open) {
    return api.sidebarAction.open().catch(() => openTab());
  }
  return openTab();
}

async function openTab() {
  if (await focusExisting()) return;
  const tab = await api.tabs.create({ url: api.runtime.getURL('index.html') });
  openTabId = tab.id;
}

/**
 * One request from a page, on its way to the app.
 *
 * The tab and frame it came from travel with it, because a write has to go
 * back to the very field it was asked about — and "the active tab" is not
 * that: by the time the model has written anything the person may well be
 * reading something else.
 */
async function queue(request, sender) {
  const pending = await read(session, QUEUE_KEY, []);
  pending.push({
    ...request,
    tabId: sender.tab?.id ?? null,
    frameId: sender.frameId ?? 0,
    at: Date.now(),
  });
  // A bound, so a panel that never opens cannot let this grow without end.
  try { await session?.set({ [QUEUE_KEY]: pending.slice(-8) }); } catch { /* nothing to queue into */ }
  // For a panel that is already open and will never boot again. Nothing is
  // sent with it: the app claims the queue, which is what keeps one request
  // from being acted on twice.
  api.runtime.sendMessage({ type: 'ivx:page-nudge' }).catch(() => { /* nobody listening yet */ });
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message?.type) {
    /* From a page: act on this. The panel opens first, synchronously, while
       the click that asked for it still counts as a gesture. */
    case 'ivx:page-action': {
      const { type, ...request } = message;
      openApp(sender.tab?.id);
      queue(request, sender).then(() => sendResponse({ ok: true }));
      return true;
    }

    /* From the app, at boot and at every nudge: what has come in. Claimed, not
       read — whoever asks takes it, and a second asker gets nothing. */
    case 'ivx:page-pending': {
      read(session, QUEUE_KEY, [])
        .then(async pending => {
          try { await session?.remove(QUEUE_KEY); } catch { /* already gone */ }
          sendResponse({ pending });
        });
      return true;
    }

    /* From the app: put this in that field, in the frame that offered it. */
    case 'ivx:page-write': {
      if (message.tabId === null || message.tabId === undefined) {
        sendResponse({ ok: false, error: 'The page this was asked from is gone.' });
        return false;
      }
      api.tabs.sendMessage(message.tabId, {
        type: 'ivx:page-write',
        fieldId: message.fieldId,
        text: message.text,
        mode: message.mode,
      }, { frameId: message.frameId ?? 0 })
        .then(result => sendResponse(result || { ok: false, error: 'The page did not answer.' }))
        .catch(() => sendResponse({
          ok: false,
          error: 'That page is no longer listening — it may have been closed or reloaded.',
        }));
      return true;
    }

    /* From the app whenever its agents change: the names content.js offers in
       its picker. Only names and ids — nothing about a provider, a model or a
       key is ever put where a page could reach it. */
    case 'ivx:agents': {
      const agents = (message.agents || [])
        .map(a => ({ id: String(a.id), name: String(a.name) }))
        .slice(0, 100);
      (local?.set({ [AGENTS_KEY]: agents }) ?? Promise.resolve())
        .catch(() => { /* nothing to store into; the picker falls back */ })
        .then(() => sendResponse({ ok: true }));
      return true;
    }

    /* From a page: who can be asked. */
    case 'ivx:page-agents': {
      read(local, AGENTS_KEY, []).then(agents => sendResponse({ agents }));
      return true;
    }

    default:
      return false;
  }
});
