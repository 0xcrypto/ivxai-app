// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* The CORS bridge: an optional loopback daemon that forwards provider calls.

   A browser will not let this page talk to an endpoint that does not answer
   with CORS headers, and plenty of them do not — Ollama on its defaults, a
   bare llama.cpp build, a company proxy from 2016. That is a rule about the
   browser, not about the endpoint: the same machine can reach it perfectly
   well. So the bridge is a small program on that machine which does.

   It is off until you turn it on, and this module is all the app knows about
   it: where it is, whether it answered, and how to rewrite one URL to go
   through it. Requests still carry your key and still go to the endpoint you
   configured — one extra hop, over loopback, on your own computer.

   In the desktop and mobile app the same server runs inside the app process
   and announces itself on `window.__IVX_BRIDGE__`, so there is nothing to
   install and nothing to turn on. See github.com/ivxlabs/ivxai-app. */

import { kvGet, kvSet } from './store.js';

/** Bumped when /proxy changes shape; /health reports what the daemon speaks. */
export const PROTOCOL = 1;

export const DEFAULT_URL = 'http://127.0.0.1:8787';

/* Both spellings of loopback: which one resolves, and how fast, differs
   between machines, and a daemon bound to 127.0.0.1 may not answer on ::1. */
const CANDIDATES = [DEFAULT_URL, 'http://localhost:8787'];

const KV_KEY = 'bridge';

const state = {
  enabled: false,
  url: '',
  token: '',
  builtIn: false,   // supplied by the desktop/mobile shell, not configurable
  health: null,     // last /health response, or null if it did not answer
  checkedAt: 0,
};

const trimSlash = url => String(url || '').replace(/\/+$/, '');

/**
 * Ask a bridge what it is.
 *
 * /health answers every origin, including ones /proxy would refuse, and says
 * so in `originAllowed`. That is the difference between "nothing is listening"
 * and "something is listening but not for this page" — two problems with very
 * different fixes, which a bare CORS failure cannot tell apart.
 */
export async function probe(url, { timeoutMs = 2500 } = {}) {
  const base = trimSlash(url);
  if (!base) throw new Error('No address');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/health`, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`The bridge answered ${res.status}`);
    const json = await res.json();
    if (json?.name !== 'ivx-bridge') throw new Error('Something else is on that port');
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/** Try the usual addresses and return the first bridge that answers. */
export async function detect({ extra = [] } = {}) {
  const seen = new Set();
  const urls = [...extra, ...CANDIDATES].map(trimSlash).filter(u => u && !seen.has(u) && seen.add(u));
  for (const url of urls) {
    try {
      return { url, health: await probe(url, { timeoutMs: 1200 }) };
    } catch {
      /* nothing there — try the next spelling */
    }
  }
  return null;
}

/* ── configuration ─────────────────────────────────────────── */

/**
 * Read the saved setting, or adopt the one the app shell injected.
 *
 * Returns immediately; it does not wait on the network. Call `verify()` after
 * to find out whether the bridge is actually there.
 */
export async function init() {
  const injected = globalThis.__IVX_BRIDGE__;
  if (injected?.url) {
    Object.assign(state, {
      builtIn: true,
      enabled: true,
      url: trimSlash(injected.url),
      token: injected.token || '',
    });
    return status();
  }
  const saved = await kvGet(KV_KEY, null);
  if (saved?.url) {
    Object.assign(state, {
      enabled: Boolean(saved.enabled),
      url: trimSlash(saved.url),
      token: saved.token || '',
    });
  }
  return status();
}

const persist = () => kvSet(KV_KEY, {
  enabled: state.enabled,
  url: state.url,
  token: state.token,
});

/**
 * Save where the bridge is without requiring it to be there yet.
 *
 * Separate from `enable` so the address and token can be set up before the
 * daemon is started — `enable` has to fail loudly when nothing answers, which
 * would otherwise make an address you cannot yet reach impossible to type.
 */
export async function configure({ url, token } = {}) {
  if (url !== undefined) state.url = trimSlash(url);
  if (token !== undefined) state.token = token;
  if (!state.builtIn) await persist();
  return state.enabled ? verify() : status();
}

/** Point at a bridge and turn it on. Throws if it does not answer. */
export async function enable({ url = DEFAULT_URL, token = '' } = {}) {
  const health = await probe(url);
  Object.assign(state, {
    enabled: true,
    url: trimSlash(url),
    token,
    health,
    checkedAt: Date.now(),
  });
  if (!state.builtIn) await persist();
  return status();
}

export async function disable() {
  state.enabled = false;
  state.health = null;
  if (!state.builtIn) await persist();
  return status();
}

/** Re-check a bridge we already know about. Never throws. */
export async function verify() {
  if (!state.enabled || !state.url) return status();
  try {
    state.health = await probe(state.url);
  } catch {
    state.health = null;
  }
  state.checkedAt = Date.now();
  return status();
}

/* ── using it ──────────────────────────────────────────────── */

/**
 * On, reachable, and willing to serve this origin.
 *
 * A built-in bridge skips the check. The app started that server itself, so
 * waiting for a probe to come back would send every call made in the first
 * moments straight at the provider — which is the one thing that cannot work
 * in a webview. If it really is broken, a bridge error says so; silently
 * falling back to a route we know is blocked would not.
 */
export function ready() {
  if (state.builtIn) return true;
  return Boolean(state.enabled && state.health?.ok && state.health.originAllowed);
}

export function status() {
  return {
    ...state,
    ready: ready(),
    reachable: Boolean(state.health?.ok),
    // A bridge from a different era of the app. Better to say so than to send
    // it requests it will not understand.
    outdated: Boolean(state.health && state.health.protocol !== PROTOCOL),
  };
}

/**
 * Rewrite one request to travel via the bridge.
 *
 * Returns `[url, headers]` unchanged when the bridge is off or unreachable, so
 * every call site is a single line and there is no second code path to keep in
 * step. The token goes in a header rather than the query string to keep it out
 * of anything that records URLs.
 */
export function apply(url, headers = {}) {
  if (!ready()) return [url, headers];
  const via = `${state.url}/proxy?url=${encodeURIComponent(url)}`;
  return [via, state.token ? { ...headers, 'X-Ivx-Token': state.token } : headers];
}

/** One line for a settings row. */
export function describe() {
  if (!state.enabled) return 'Off — the browser talks to providers directly';
  if (state.builtIn) return state.health ? 'Built into this app' : 'Built in, but not answering';
  if (!state.health) return `Not answering at ${state.url}`;
  if (!state.health.originAllowed) return 'Running, but not accepting this origin';
  if (status().outdated) return `Running, but speaks protocol ${state.health.protocol}`;
  return `On — via ${state.url}`;
}
