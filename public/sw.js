// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* Offline shell for ivx AI Chat.

   This worker only ever touches same-origin GET requests for the app's own
   files. Provider API calls (different origin, and POSTs) fall straight
   through to the network — they are never cached, inspected or rewritten.

   The /proxy exception below matters when the CORS bridge is also serving the
   app: then it and the page share an origin, and a model list is a same-origin
   GET that would otherwise be answered from the shell cache. */

/* VERSION and SHELL are stamped in by the sw-precache plugin in
   vite.config.js, so the cache name changes whenever any asset does. */
const VERSION = '__CACHE_VERSION__';
const CACHE = `ivx-shell-${VERSION}`;

const SHELL = __PRECACHE_MANIFEST__;


/* Installing does NOT activate. A new worker sits in `waiting` until the page
   sends 'skip-waiting' below, because activate() deletes every other cache —
   including the one the currently open page is still running from. Taking that
   away underneath a live tab leaves it with a new worker and an old UI, which
   is the half-updated state that made "reload to update" unreliable.

   A very first install has no worker to replace, so it activates immediately
   regardless of this; only genuine updates wait. */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      // addAll is atomic: one 404 would throw away the whole install, so add
      // entries individually and let a single failure be survivable.
      .then(cache => Promise.all(SHELL.map(url => cache.add(url).catch(() => {}))))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* The page asking to be updated. Activating claims the clients, which fires
   `controllerchange` there and is the page's cue that a reload will now get
   the new shell rather than the old one again. */
self.addEventListener('message', event => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

const INDEX = './index.html';

/* Vite tags its JS and CSS with crossorigin, so the browser sends an Origin
   header for them, and static hosts answer with `Vary: Origin`. The requests
   made during install carry no Origin, so a default lookup would never match
   those entries — hence ignoreVary. */
const MATCH = { ignoreSearch: true, ignoreVary: true };

const offline = () => new Response('Offline', {
  status: 503,
  headers: { 'Content-Type': 'text/plain' },
});

const store = (key, response) => {
  const copy = response.clone();
  caches.open(CACHE).then(cache => cache.put(key, copy)).catch(() => {});
};

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;      // provider traffic: hands off
  if (url.pathname === '/proxy') return;                // bridge traffic: likewise

  // The document is network first, so a redeploy is picked up on the next
  // load rather than a load after that.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(res => { if (res.ok) store(INDEX, res); return res; })
        .catch(() => caches.match(INDEX, MATCH).then(hit => hit || offline()))
    );
    return;
  }

  // Everything else is a content-hashed build artefact: immutable, so cache
  // first is both correct and the fastest path.
  event.respondWith(
    caches.match(request, MATCH).then(hit => hit || fetch(request)
      .then(res => {
        if (res.ok && res.type === 'basic') store(request, res);
        return res;
      })
      .catch(offline))
  );
});
