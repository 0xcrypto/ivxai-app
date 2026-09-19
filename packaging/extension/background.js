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
