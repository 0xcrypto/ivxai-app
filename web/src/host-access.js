// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* Permission to reach one endpoint, asked for when there is an endpoint to
   reach.

   The extension used to declare `<all_urls>` in its manifest, which a browser
   shows on install as "read and change all your data on all websites". For an
   app whose entire claim is that it has no backend and reads nothing, that is
   a bad first sentence, and it is not even the sentence we mean: the extension
   never touches a page the person visits. It calls one address — the one they
   typed into it.

   So the permission is optional, and asked for per host. What makes that
   practical is that most endpoints need no permission at all. A provider that
   answers with CORS headers — OpenAI, Anthropic, OpenRouter, Groq, the
   HuggingFace downloads WebLLM makes, the bridge itself — is reachable from
   any page on the web, which is why the hosted build works at all. Host access
   buys something only where the endpoint refuses browser origins: Ollama, LM
   Studio, llama.cpp, a server someone runs themselves. Those are the ones
   worth a prompt, and they are the ones the person went looking for.

   Three rules from the browser, and all three shape the callers:

     - A match pattern carries no port. `http://localhost:11434` and
       `http://localhost:1234` are one grant, not two, and asking for either
       asks for every port on that host. Nothing can be done about that, so the
       UI says it rather than implying otherwise.
     - `request()` needs a user gesture, and an `await` before it loses one.
       Every call site asks first and does its own work afterwards.
     - What is granted has to be readable while a screen is painting, so it is
       held here as a set and kept current by the browser's own events, rather
       than asked for again in the middle of a render. */

import { EXTENSION } from './bridge.js';

const perms = () => globalThis.browser?.permissions ?? globalThis.chrome?.permissions ?? null;

/**
 * Whether this build has to ask before it can reach an endpoint directly.
 *
 * False everywhere else — the hosted page, the desktop app — where the answer
 * to "may I call this" is CORS and nothing else. Everything below answers yes
 * when it is false, so no call site has to know which build it is in.
 */
export const MANAGED = EXTENSION && Boolean(perms());

/* Granted origin patterns, as the browser last reported them. */
const held = new Set();

/** Patterns that cover everything, however they were granted. */
const BLANKET = ['<all_urls>', '*://*/*', 'http://*/*', 'https://*/*'];

/**
 * Read what is granted, and keep reading it.
 *
 * The events matter as much as the first read: a permission can be revoked
 * from the browser's own extension page, with nothing to tell this app but
 * these.
 */
export async function init() {
  if (!MANAGED) return;
  await reload();
  perms().onAdded?.addListener(reload);
  perms().onRemoved?.addListener(reload);
}

async function reload() {
  try {
    const all = await perms().getAll();
    held.clear();
    for (const origin of all?.origins || []) held.add(origin);
  } catch {
    /* leave the last known answer in place */
  }
}

/**
 * The match pattern covering an endpoint: scheme, host, every port, every path.
 *
 * Returns null for anything a pattern cannot describe — a relative address, a
 * `file:` URL, the empty string WebLLM has instead of one — which callers read
 * as "nothing to ask for".
 */
export function patternFor(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(parsed.protocol)) return null;
  // `hostname`, not `host`: a pattern may not carry a port, and one that does
  // is rejected outright rather than quietly narrowed.
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

/** The host a grant is really about, for saying so on screen. */
export function hostOf(url) {
  try { return new URL(url).hostname; } catch { return String(url || ''); }
}

const patterns = urls => [...new Set(
  (Array.isArray(urls) ? urls : [urls]).map(patternFor).filter(Boolean),
)];

/**
 * Has this endpoint been allowed? Answers from what is already known, so a
 * screen can ask while it paints.
 *
 * Yes for an address there is nothing to ask about, which is the honest answer
 * for WebLLM and for anything that is not an http address at all.
 */
export function granted(urls) {
  if (!MANAGED) return true;
  const origins = patterns(urls);
  if (!origins.length) return true;
  if (BLANKET.some(p => held.has(p))) return true;
  return origins.every(o => held.has(o));
}

/**
 * Ask for it. Must be called straight out of a click, before any `await`.
 *
 * Resolves false when the person says no, which is an ordinary answer and not
 * an error: the endpoint may answer a plain CORS request anyway, and the
 * bridge reaches it either way.
 */
export async function request(urls) {
  if (!MANAGED) return true;
  const origins = patterns(urls);
  if (!origins.length) return true;
  let ok = false;
  try {
    ok = await perms().request({ origins });
  } catch {
    // A pattern the browser would not take — an IPv6 literal, say — or a call
    // that lost its gesture on the way here.
    ok = false;
  }
  await reload();
  return ok;
}

/** Give one back, when nothing is left that needs it. */
export async function drop(urls) {
  if (!MANAGED) return true;
  const origins = patterns(urls);
  if (!origins.length) return true;
  try {
    await perms().remove({ origins });
  } catch {
    /* nothing granted, or not ours to drop */
  }
  await reload();
  return true;
}
