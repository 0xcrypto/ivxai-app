// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* Page tools: the app's end of the bar that appears on a page.

   Selecting text on an allowed site offers to summarize it, translate it or
   put a question about it to an agent; focusing a text field offers to write
   into it. The page draws those (packaging/extension/content.js) and the
   background script carries them here (packaging/extension/background.js);
   what this module does is claim the requests, turn them into chats, and offer
   the one tool that can write back.

   Only in the extension. On the hosted page and in the desktop app there is no
   page to read and no field to write to, so `AVAILABLE` is false and every
   call below answers as if nothing were configured — no call site has to know
   which build it is in.

   ── the write tool, and why it is a tool

   The obvious way to fill a field is to put the reply in it. It is also wrong:
   a model asked to write an email replies "Sure — here's a draft:" and a
   sentence of preamble, and that preamble lands in someone's outbox. So the
   model is given a tool instead. It writes the text inside a `<write>` block,
   the block is parsed out the way `<ask>` and `<tool>` are, and only what was
   inside it is sent to the field. The model can then say whatever it likes to
   the reader — that text stays in the chat, where it was aimed.

   ── which sites

   One at a time, and none on install. `sites()` is the list of match patterns
   page tools may run on; it is kept where the background script can read it,
   because the background script is what registers the content script, and it
   only ever holds patterns the browser has actually granted. Removing the last
   one turns the feature off as completely as never having enabled it: the
   script is unregistered and the permission is given back. */

import { EXTENSION } from './bridge.js';
import * as access from './host-access.js';

const runtime = () => globalThis.browser?.runtime ?? globalThis.chrome?.runtime ?? null;
const storage = () => globalThis.browser?.storage?.local ?? globalThis.chrome?.storage?.local ?? null;

/** Whether this build can put a bar on a page at all. */
export const AVAILABLE = EXTENSION && Boolean(runtime()?.sendMessage) && Boolean(storage()) &&
  Boolean(globalThis.browser?.scripting ?? globalThis.chrome?.scripting);

const SITES_KEY = 'ivx:page-sites';

/* The allowed patterns, as last read. Held rather than fetched, so a settings
   screen can ask while it paints — the same bargain host-access.js makes. */
let allowed = [];
/* What to do with a request from a page. Set by init(); the app supplies it. */
let handler = null;

const send = async message => {
  try {
    return await runtime().sendMessage(message);
  } catch {
    return null;   // the background script went away, or was never there
  }
};

/**
 * Start listening, and pick up anything that came in before we were ready.
 *
 * Both halves matter. The nudge is for a panel that is already open — a second
 * selection while the first answer is still streaming. The claim is for the
 * ordinary case: the click that sends a request is also the click that opens
 * the panel, so the request is always waiting before this page exists.
 */
export async function init(onAction) {
  if (!AVAILABLE) return;
  handler = onAction;
  allowed = await readSites();
  runtime().onMessage.addListener(message => {
    if (message?.type === 'ivx:page-nudge') claim();
    return false;
  });
  await claim();
}

/** Take whatever the background script is holding and act on each request in
    the order it arrived. Claimed, not read: nothing is acted on twice. */
async function claim() {
  const reply = await send({ type: 'ivx:page-pending' });
  for (const request of reply?.pending || []) {
    try {
      await handler?.(request);
    } catch {
      /* one bad request does not swallow the rest */
    }
  }
}

/* The last thing published, so the same list is not sent again. This is
   called from updateChip, which runs on every render that could have changed
   the answering agent — most of which changed neither. */
let published = '';

/**
 * Tell the page's agent picker who there is to ask, and which of them the
 * chat on screen is on.
 *
 * `active` is what the picker opens on, so the bar offers the agent the person
 * can see they are talking to rather than whichever one they used last.
 *
 * Names and ids only. A provider, a model, an endpoint and a key are none of a
 * page's business, and this is the one thing the app puts where a page can
 * reach it.
 */
export function publishAgents(agents, active = null) {
  if (!AVAILABLE) return;
  const payload = {
    agents: agents.map(a => ({ id: a.id, name: a.name })),
    active: active ?? null,
  };
  const key = JSON.stringify(payload);
  if (key === published) return;
  published = key;
  send({ type: 'ivx:agents', ...payload });
}

/* ── which sites ───────────────────────────────────────────── */

async function readSites() {
  try {
    return (await storage().get(SITES_KEY))?.[SITES_KEY] || [];
  } catch {
    return [];
  }
}

async function writeSites(next) {
  allowed = next;
  try {
    await storage().set({ [SITES_KEY]: next });
  } catch {
    /* nothing to store into; the background script keeps its last list */
  }
}

/** The match patterns page tools run on, as they were last saved. */
export const sites = () => [...allowed];

/** The pattern covering everything, spelled the way the browser spells it. */
export const EVERY_SITE = '<all_urls>';

/** A host as a pattern, or null when it is not one a browser would take. */
export function patternFor(host) {
  const text = String(host || '').trim();
  if (!text) return null;
  if (text === EVERY_SITE) return EVERY_SITE;
  // Typed by hand, so both "example.com" and a pasted address have to work.
  const url = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  return access.patternFor(url);
}

/**
 * Allow a site, asking the browser first.
 *
 * Must be called straight out of a click: the permission prompt needs the
 * gesture, and an await before it loses one. Answers false when the person
 * says no, which is an ordinary answer — nothing is saved in that case, so the
 * list never claims a reach the extension does not have.
 */
export async function allow(pattern) {
  if (!AVAILABLE || !pattern) return false;
  const perms = globalThis.browser?.permissions ?? globalThis.chrome?.permissions;
  let ok = false;
  try {
    ok = await perms.request({ origins: [pattern] });
  } catch {
    ok = false;
  }
  if (!ok) return false;
  if (!allowed.includes(pattern)) await writeSites([...allowed, pattern]);
  return true;
}

/**
 * Stop running on a site.
 *
 * The permission goes back with the pattern. It is not shared with anything
 * else the extension does — a provider endpoint is granted by host-access.js
 * under its own pattern and is not in this list — except for `<all_urls>`,
 * which covers everything by definition; dropping that would take a provider's
 * grant with it, so it is only removed from the list and the browser keeps it
 * until the person revokes it themselves.
 */
export async function forget(pattern) {
  if (!AVAILABLE) return;
  await writeSites(allowed.filter(p => p !== pattern));
  if (pattern === EVERY_SITE) return;
  const perms = globalThis.browser?.permissions ?? globalThis.chrome?.permissions;
  try {
    await perms.remove({ origins: [pattern] });
  } catch {
    /* not ours to drop, or already gone */
  }
}

/** The language Translate aims at when the person has not named one: the one
    their browser is in, written in that language's own name. */
export function defaultLanguage() {
  const tag = navigator.language || 'en';
  try {
    return new Intl.DisplayNames([tag], { type: 'language' }).of(tag) || tag;
  } catch {
    return tag;   // an engine without Intl.DisplayNames; the tag is readable enough
  }
}

/* ── the write tool ────────────────────────────────────────── */

/* Deliberately the same shape as `<ask>` and `<tool>`: a tagged block in the
   reply text, parsed out afterwards. Native function calling would be neater
   and would not work — a bare llama.cpp build has no such concept, and page
   tools are exactly as useful on a local model as on a hosted one. */
const WRITE_RE = /<write(?:\s+mode="([^"]*)")?\s*>([\s\S]*?)<\/write>/g;

export { WRITE_RE };

/** The complete write blocks in a reply, in order. */
export const writeCalls = content => [...String(content || '').matchAll(WRITE_RE)]
  .map(m => ({ mode: (m[1] || 'replace').trim(), text: m[2] }));

/**
 * The system-prompt section that teaches the tool, or '' when this chat is not
 * about a field.
 *
 * The instructions are blunt on purpose. Everything a model normally does to
 * be helpful — introducing the text, offering alternatives, wrapping it in
 * quotes — is wrong inside the block, because the block is not read by a
 * person: it is typed into a field on a form someone is about to submit.
 */
export function promptSection(field) {
  if (!field) return '';
  const what = field.label ? `the “${field.label}” field` : 'a text field';
  const where = field.pageTitle ? ` on ${field.pageTitle}` : '';
  return '\n\n# Writing into the page\n' +
    `This conversation is about ${what}${where}, which you can write into.\n` +
    'When you have the text that belongs in the field, output exactly this block:\n' +
    '<write>the exact text to put in the field</write>\n' +
    'What is inside the block is what lands in the field, character for character. ' +
    'Put nothing else in it: no preamble, no surrounding quotation marks, no explanation, ' +
    'no alternatives to choose between.\n' +
    'Anything you want the person to read — what you changed, what you were unsure of — ' +
    'goes outside the block, where they will see it in the chat.\n' +
    `<write mode="insert">…</write> adds to what is in the field instead of replacing it.\n` +
    (field.multiline ? '' : 'The field takes a single line, so write one.\n') +
    (field.value
      ? `What is in the field now:\n${field.value}`
      : 'The field is empty.');
}

/**
 * Run one write: send the text to the frame that offered the field, and say
 * what happened in words the model can act on.
 *
 * A failure is an answer, not an exception — the tab was closed, the page
 * reloaded, the field taken off the form. The model is told which, so it can
 * tell the person rather than carry on as if the text had landed.
 */
export async function executeWriteTool(call, field) {
  const text = String(call.text ?? '');
  if (!AVAILABLE || !field) {
    return { ok: false, text, answer: 'There is no page field to write to.' };
  }
  if (!text.trim()) {
    return { ok: false, text, answer: 'The write block was empty, so nothing was written.' };
  }
  const reply = await send({
    type: 'ivx:page-write',
    tabId: field.tabId,
    frameId: field.frameId,
    fieldId: field.fieldId,
    mode: call.mode === 'insert' ? 'insert' : 'replace',
    text,
  });
  if (reply?.ok) {
    return {
      ok: true, text,
      answer: `Written into ${field.label ? `“${field.label}”` : 'the field'}.`,
    };
  }
  const why = reply?.error === 'unknown-field'
    ? 'That field is no longer on the page.'
    : reply?.error || 'The page did not answer, so nothing was written.';
  return { ok: false, text, answer: why };
}
