// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* ivx/ai Chat — a local-only AI chat client.

   No analytics, no third-party requests, no backend. The only outbound traffic
   is the chat/model call the user asks for, aimed at the endpoint they typed. */

// Vendored at build time, served from our own origin — never a CDN.
import 'halfmoon/css/halfmoon.min.css';
import 'halfmoon/css/cores/halfmoon.modern.css';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-400-italic.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-sans/latin-700.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-600.css';
import './styles/theme.css';
import './styles/app.css';

import * as store from './store.js';
import * as vault from './vault.js';
import * as api from './providers.js';
import * as bridge from './bridge.js';
import * as share from './share.js';
import { renderMarkdown } from './markdown.js';
import { openSettings, openIntro, openDisclaimer, chooseModel, setShell } from './settings.js';
import {
  $, el, clear, toast, actionSnack, initSheet, openSheet, pushScreen, closeSheet, refreshSheet,
  confirmAction, promptText, copyText, downloadJSON, downloadBlob, groupLabel, autosize,
  chooseFromList,
} from './ui.js';

const DEFAULTS = {
  systemPrompt: '',
  temperature: 0.7,
  maxTokens: null,
  historyLimit: null,
};

const state = {
  ui: store.loadUI(),
  providers: [],
  agents: [],
  defaults: { ...DEFAULTS },
  conversations: [],
  conv: null,
  messages: [],
  streaming: null,
  shared: null,      // a share link being previewed; set only by acceptSharedLink
  searchHits: null,
  pinned: true,
};

const dom = {};

/* ── boot ──────────────────────────────────────────────────── */

async function boot() {
  Object.assign(dom, {
    app: $('.app'),
    drawer: $('#drawer'),
    convList: $('#convList'),
    search: $('#convSearch'),
    title: $('#convTitle'),
    messages: $('#messages'),
    input: $('#input'),
    send: $('#btnSend'),
    stop: $('#btnStop'),
    chip: $('#modelChip'),
    chipText: $('#chipText'),
    jump: $('#jump'),
    composer: $('#composer'),
    shareBar: $('#shareBar'),
  });

  initSheet();
  applyAppearance();

  const ready = await vault.init();
  // Reads the saved setting only; whether the bridge is actually up is settled
  // by the verify() below, which must not hold up the first paint.
  await bridge.init();
  state.providers = await store.kvGet('providers', []);
  state.defaults = { ...DEFAULTS, ...(await store.kvGet('defaults', {})) };

  if (!state.providers.length) {
    // Local runtimes first — they work with no key and no account.
    state.providers = ['ollama', 'lmstudio', 'openrouter']
      .map(key => api.makeProvider(api.PRESETS.find(p => p.key === key)));
    await saveProviders();
  }

  // Agents are what a chat picks — never a raw model. One is seeded per
  // provider configuration, so the list is never empty while a provider is
  // configured. Deliberately only when there are none at all: an agent the
  // user deleted stays deleted.
  state.agents = await store.kvGet('agents', []);
  if (!state.agents.length && state.providers.length) {
    state.agents = state.providers.map(newAgentFor);
    await saveAgents();
  }

  bindEvents();
  setShell(shell);
  await refreshConversations();

  // A share link in the URL outranks the last-open chat: the user followed
  // someone's link on purpose. The chat renders in the main view, read-only,
  // with the composer swapped for an add bar; none of the user's own chats
  // are loaded for a link they may simply close.
  const shared = await acceptSharedLink();
  if (shared) {
    openSharedPreview(shared);
  } else {
    const last = state.ui.lastConvId && state.conversations.find(c => c.id === state.ui.lastConvId);
    if (last) await openConversation(last.id);
    else startDraft();
  }

  // First run gets the introduction; a returning user with a locked vault gets
  // the unlock prompt. Never both — one screen at a time. While a shared chat
  // is being previewed, reading it needs no vault and opening a prompt on top
  // would bury the chat, so both wait for a visit that is not mid-preview.
  const greeted = shared ? true : await greetOnFirstVisit();
  if (!shared && !ready && !greeted) askUnlock();

  registerServiceWorker();

  // If the bridge went away since last time, the next provider call says so
  // rather than failing as a bare CORS error.
  bridge.verify();
}

/** Returns true when the welcome sheet was shown. */
async function greetOnFirstVisit() {
  if (await store.kvGet('welcomeSeenAt')) return false;
  // Recorded before it is dismissed, so a reload does not show it twice.
  await store.kvSet('welcomeSeenAt', Date.now());
  openIntro(shell);
  return true;
}

/* The browser only refetches sw.js on a navigation, or about once a day. This
   is an app people leave open for days, so left alone a tab can sit on a build
   that shipped a week ago and never know. Ask on a timer, and whenever the tab
   comes back to the front. */
const UPDATE_CHECK_MS = 60 * 60 * 1000;

/**
 * Offer the new version, and apply it only when asked.
 *
 * The worker installs the new shell and then stops (see public/sw.js), so
 * nothing about the running page changes until the button below is pressed.
 * That press is also what makes the reload reliable: the page waits for the
 * new worker to actually take over before reloading, where pressing the
 * browser's own refresh could just as easily reload the old shell again.
 */
function registerServiceWorker() {
  // Skipped in dev: the precache manifest is stamped in at build time, and a
  // caching worker in front of the dev server only causes confusion.
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).then(reg => {
    let notice = null;
    let declined = false;

    const offer = worker => {
      if (!worker || notice || declined) return;
      notice = actionSnack('A new version is ready', 'Update', {
        onAction: () => {
          notice?.close();
          notice = null;
          // Reload once the new worker is in charge, not before: reloading
          // first would be served by the old one and change nothing.
          navigator.serviceWorker.addEventListener(
            'controllerchange', () => location.reload(), { once: true },
          );
          worker.postMessage('skip-waiting');
        },
        // Dismissing means dismissed. It is offered again on the next visit,
        // which is soon enough for something that is not urgent.
        onDismiss: () => { notice = null; declined = true; },
      });
    };

    // Installed on an earlier visit and still waiting to be let in.
    offer(reg.waiting);

    reg.addEventListener('updatefound', () => {
      const installing = reg.installing;
      installing?.addEventListener('statechange', () => {
        // No controller means this is a first install, not an update: there is
        // nothing being replaced and nothing to ask about.
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          offer(installing);
        }
      });
    });

    const check = () => { if (navigator.onLine) reg.update().catch(() => {}); };
    setInterval(check, UPDATE_CHECK_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  }).catch(() => { /* offline support is a nicety; the app works without it */ });
}

/* ── appearance ────────────────────────────────────────────── */

function applyAppearance() {
  const { theme, width } = state.ui;
  const resolved = theme === 'auto'
    ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : theme;
  document.documentElement.dataset.bsTheme = resolved;
  document.documentElement.dataset.bsCore = 'modern';
  document.documentElement.dataset.width = width || 'default';
  $('meta[name="theme-color"]')?.setAttribute('content', resolved === 'light' ? '#fafafa' : '#0a0a0a');
}

matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (state.ui.theme === 'auto') applyAppearance();
});

function saveUI(patch) {
  state.ui = { ...state.ui, ...patch };
  store.saveUI(state.ui);
}

/* ── providers ─────────────────────────────────────────────── */

const saveProviders = () => store.kvSet('providers', state.providers);
const providerById = id => state.providers.find(p => p.id === id) || null;
const currentProvider = () => providerById(state.conv?.providerId) || state.providers[0] || null;

/* ── agents ────────────────────────────────────────────── */

/* An agent is what a chat uses: a name, a provider, a model, and the prompt
   and sampling that go with them. Conversations point at one by id and read
   its settings live, so editing an agent is how every chat using it changes. */

const saveAgents = () => store.kvSet('agents', state.agents);
const agentById = id => state.agents.find(a => a.id === id) || null;
const agentOf = conv => (conv?.agentId && agentById(conv.agentId)) || null;

/** The default agent for a provider configuration, seeded from what the
    provider and the app defaults already say. */
const newAgentFor = provider => ({
  id: store.uid(),
  name: provider.name,
  providerId: provider.id,
  model: provider.defaultModel || '',
  systemPrompt: state.defaults.systemPrompt || '',
  temperature: state.defaults.temperature,
  maxTokens: state.defaults.maxTokens,
  historyLimit: state.defaults.historyLimit,
});

/** A chat leaving an agent (agent deleted, provider removed) does not lose
    its footing: it takes a snapshot of the agent's settings and continues
    with those instead. */
function snapshotAgent(conv, agent) {
  Object.assign(conv, {
    providerId: agent.providerId, model: agent.model, systemPrompt: agent.systemPrompt,
    temperature: agent.temperature, maxTokens: agent.maxTokens, historyLimit: agent.historyLimit,
  });
  delete conv.agentId;
}

const field = (label, control) => el('div', { class: 'field' }, [
  el('label', { class: 'field-label', text: label }),
  control,
]);

/* ── tools ─────────────────────────────────────────────── */

/* The first tool, ask-another-agent, is a text protocol rather than native
   function calling on purpose: it works with every provider this app can
   talk to, including bare llama.cpp builds with no function-calling concept.
   The model asks by writing a tagged block; the block is parsed from the
   reply, a real thread is run with the named agent, and the answer is fed
   back as the next request's history so the model can finish with it. */

const ASK_RE = /<ask\s+agent="([^"]*)"\s*>([\s\S]*?)<\/ask>/g;

/** The complete ask blocks in a reply, in order. */
const askCalls = content => [...String(content || '').matchAll(ASK_RE)]
  .map(m => ({ agent: m[1].trim(), prompt: m[2].trim() }));

/** Splits a reply for display: ask blocks are the model talking to the tool
    plumbing, not to the reader, so they stay out of the visible text — the
    tool card below the message carries the question and the answer. */
function splitAskBlocks(content) {
  const out = [];
  let last = 0;
  for (const m of String(content || '').matchAll(ASK_RE)) {
    const head = content.slice(last, m.index);
    if (head.trim()) out.push({ text: head });
    out.push({ ask: true, agent: m[1], prompt: m[2] });
    last = m.index + m[0].length;
  }
  const tail = content.slice(last);
  const cut = tail.indexOf('<ask');          // an unfinished block mid-stream
  if (cut >= 0) {
    const head = tail.slice(0, cut);
    if (head.trim()) out.push({ text: head });
  } else if (tail.trim()) {
    out.push({ text: tail });
  }
  return out;
}

const MAX_TOOL_ROUNDS = 3;

/** The system-prompt section that teaches the tool, or '' when it is off.
    Sub-threads never receive it — their runs go straight to streamChat — so
    a delegated question cannot spawn more delegation. */
function toolsPrompt(agent) {
  if (!state.agents.length || !agent || agent.tools === false) return '';
  const list = state.agents.map(a => `- ${a.name}`).join('\n');
  return '\n\n# Asking other agents\n' +
    'You may delegate a question to a separate agent thread. It runs with its own ' +
    'context and you receive only its answer, so put everything it needs inside the question.\n' +
    'To ask, output exactly this block:\n' +
    '<ask agent="Agent name">\nYour question for that agent.\n</ask>\n' +
    'Use it sparingly, only when another agent would answer better. At most three questions per reply; ' +
    'after each answer arrives you will be asked to continue.\n' +
    `Available agents:\n${list}`;
}

/** Run one delegated question in its own thread with its own agent, and
    return the answer — or a failure the model can read and react to. */
async function executeAskTool(call, controller) {
  const prompt = String(call.prompt || '').trim();
  const wanted = String(call.agent || '').trim().toLowerCase();
  const target = state.agents.find(a => a.name.toLowerCase() === wanted) || null;
  if (!target) {
    return {
      agentName: call.agent || '', agentId: null, threadId: null, prompt,
      answer: `No agent named “${call.agent}”. Available agents: ` +
        (state.agents.map(a => a.name).join(', ') || 'none') + '.',
    };
  }
  const provider = providerById(target.providerId);
  if (!provider || !target.model) {
    return {
      agentName: target.name, agentId: target.id, threadId: null, prompt,
      answer: `${target.name} has no model configured and cannot answer.`,
    };
  }

  // The thread is a real conversation, persisted before the call so it exists
  // even if the user stops everything a moment later.
  const thread = store.newConversation({
    providerId: target.providerId, model: target.model,
    systemPrompt: target.systemPrompt || '',
    temperature: target.temperature, maxTokens: target.maxTokens,
    historyLimit: target.historyLimit,
  });
  thread.title = `${target.name}: ${prompt.slice(0, 60)}`;
  thread.agentId = target.id;
  await store.putConversation(thread);
  await store.putMessage(store.newMessage(thread.id, 'user', prompt, 0));
  await refreshConversations();

  let answer;
  try {
    const result = await api.streamChat({
      provider,
      apiKey: vault.getKey(provider.id),
      model: target.model,
      system: target.systemPrompt || state.defaults.systemPrompt || '',
      messages: [{ role: 'user', content: prompt }],
      temperature: target.temperature,
      maxTokens: target.maxTokens,
      signal: controller.signal,             // the parent's stop button covers it
    });
    answer = result.text || '';
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    answer = `The agent could not answer: ${err.message || err}`;
  }
  thread.updatedAt = Date.now();
  await store.putMessage(store.newMessage(thread.id, 'assistant', answer, 1, {
    model: target.model, providerId: target.providerId,
  }));
  await store.putConversation(thread);
  await refreshConversations();
  return { agentName: target.name, agentId: target.id, threadId: thread.id, prompt, answer };
}

/** Called whenever a provider is configured (added, or gains a default model):
    guarantees it has a default agent, makes it the one new chats use, and
    offers it to the chat on screen if that has not chosen one yet. */
async function attachDefaultAgent(provider) {
  let agent = state.agents.find(a => a.providerId === provider.id);
  if (!agent) {
    agent = newAgentFor(provider);
    state.agents.push(agent);
    await saveAgents();
    saveUI({ lastAgentId: agent.id });
  } else if (!agent.model && provider.defaultModel) {
    agent.model = provider.defaultModel;
    await saveAgents();
  }
  if (state.conv?.draft && !state.conv.agentId) {
    state.conv.agentId = agent.id;
    state.conv.providerId = agent.providerId;
    state.conv.model = agent.model;
  }
  updateChip();
  return agent;
}

/** Providers go away; their agents must not linger pointing at nothing. */
async function forgetProvider(provider) {
  if (state.agents.some(a => a.providerId === provider.id)) {
    state.agents = state.agents.filter(a => a.providerId !== provider.id);
    await saveAgents();
  }
  if (state.ui.lastAgentId && !agentById(state.ui.lastAgentId)) {
    saveUI({ lastAgentId: state.agents[0]?.id ?? null });
  }
  for (const c of state.conversations) {
    const agent = agentById(c.agentId);
    if (!agent) continue;
    snapshotAgent(c, agent);
    await store.putConversation(c);
    if (state.conv?.id === c.id) snapshotAgent(state.conv, agent);
  }
  updateChip();
}

function updateChip() {
  const agent = agentOf(state.conv);
  if (agent) {
    dom.chipText.textContent = agent.model ? agent.name : `${agent.name} · pick a model`;
    return;
  }
  const provider = currentProvider();
  const model = state.conv?.model || provider?.defaultModel;
  dom.chipText.textContent = provider
    ? (model ? `${provider.name} · ${model}` : `${provider.name} · choose a model`)
    : 'Add a provider';
}

/** Pull the model list in the background; silent on failure. */
async function warmModels(provider) {
  if (!provider || provider.models?.length) return;
  const preset = api.PRESETS.find(p => p.key === provider.preset);
  if (preset?.needsKey && !vault.getKey(provider.id)) return;
  try {
    provider.models = await api.listModels(provider, vault.getKey(provider.id));
    if (!provider.defaultModel && provider.models.length) {
      provider.defaultModel = provider.models[0];
    }
    await saveProviders();
    if (state.conv && !state.conv.model) state.conv.model = provider.defaultModel;
    updateChip();
  } catch { /* the picker offers a Fetch action */ }
}

/* ── conversations ─────────────────────────────────────────── */

async function refreshConversations() {
  state.conversations = await store.listConversations();
  renderConvList();
}

function renderConvList() {
  const list = clear(dom.convList);
  const query = dom.search.value.trim().toLowerCase();

  let items = state.conversations;
  if (query) {
    items = items.filter(c => (c.title || '').toLowerCase().includes(query) ||
      (state.searchHits?.has(c.id) ?? false));
  }
  if (!items.length) {
    list.append(el('p', { class: 'conv-empty', text: query ? 'Nothing matches' : 'No chats yet' }));
    return;
  }

  let group = null;
  for (const conv of items) {
    const label = groupLabel(conv.updatedAt);
    if (label !== group) {
      group = label;
      list.append(el('div', { class: 'conv-group', text: label }));
    }
    list.append(el('button', {
      class: `conv-item${conv.id === state.conv?.id ? ' is-active' : ''}`,
      type: 'button',
      onclick: () => { openConversation(conv.id); closeDrawer(); },
    }, [
      el('span', { class: 'conv-item-title', text: conv.title || 'Untitled' }),
    ]));
  }
}

function startDraft() {
  detachStreaming();
  exitSharedPreview();
  // New chats speak in agents: the last one used, else the first configured.
  const agent = state.agents.find(a => a.id === state.ui.lastAgentId) || state.agents[0] || null;
  const provider = agent ? providerById(agent.providerId) : (state.providers[0] || null);
  state.conv = {
    ...store.newConversation({
      ...state.defaults,
      providerId: agent?.providerId ?? provider?.id ?? null,
      model: agent?.model ?? provider?.defaultModel ?? '',
    }),
    draft: true,
    agentId: agent?.id ?? null,
  };
  state.messages = [];
  saveUI({ lastConvId: null });
  renderConvList();
  renderHeader();
  renderMessages();
  warmModels(provider);
}

async function openConversation(id) {
  const conv = await store.getConversation(id);
  if (!conv) { startDraft(); return; }
  detachStreaming();
  exitSharedPreview();
  state.conv = conv;
  state.messages = await store.listMessages(id);
  saveUI({ lastConvId: id });
  renderConvList();
  renderHeader();
  renderMessages(true);
  warmModels(currentProvider());
  // If a background stream belongs to this conversation, re-attach the UI.
  if (state.streaming?.convId === id) setBusy(true);
}

async function persistConversation(patch = {}) {
  if (!state.conv) return;
  Object.assign(state.conv, patch, { updatedAt: Date.now() });
  const { draft, ...record } = state.conv;
  await store.putConversation(record);
  state.conv.draft = false;
  saveUI({ lastConvId: record.id });
  await refreshConversations();
}

function renderHeader() {
  dom.title.textContent = state.shared
    ? (state.shared.conversation.title || 'Shared chat')
    : state.conv?.title || 'New chat';
  updateChip();
}

/* ── shared-chat preview ───────────────────────────────── */

/** Preview mode owns the whole main view: the chat's messages render like a
    conversation, and the composer gives way to an add bar. No conversation is
    loaded, so nothing a later click does can mix the two together. */
function openSharedPreview(bundle) {
  state.shared = bundle;
  dom.composer.hidden = true;
  dom.shareBar.hidden = false;
  renderHeader();
  renderMessages(true);
}

/** Leaving preview mode is idempotent: every exit (adding the chat, opening
    one of the user's own, starting a new one) goes through here. */
function exitSharedPreview() {
  if (!state.shared) return;
  state.shared = null;
  dom.composer.hidden = false;
  dom.shareBar.hidden = true;
}

async function addSharedChat() {
  const bundle = state.shared;
  if (!bundle) return;
  const btn = $('#btnAddShared');
  btn.disabled = true;
  try {
    const id = await share.importShared(bundle);
    exitSharedPreview();
    await refreshConversations();
    await openConversation(id);
    toast('Shared chat added');
  } catch (err) {
    btn.disabled = false;
    toast(err.message || 'Could not add the chat', 'err');
  }
}

/* ── message rendering ─────────────────────────────────────── */

function messageNode(msg) {
  const node = el('article', {
    class: `msg msg-${msg.role}${msg.error ? ' msg-error' : ''}`,
    dataset: { id: msg.id },
  });

  const body = msg.role === 'user'
    ? el('div', { class: 'bubble' })
    : el('div', { class: 'prose' });
  paintBody(body, msg);

  node.append(body, footNode(msg));
  return node;
}

function paintBody(body, msg) {
  clear(body);

  if (msg.role === 'user') {
    body.textContent = msg.content;
    return;
  }
  if (msg.role === 'tool') {
    // The answer an agent thread sent back to the model. The card is the
    // record of the question; the thread itself holds the full exchange.
    body.append(el('details', { class: 'tool-ask' }, [
      el('summary', { class: 'tool-ask-head' }, [
        el('span', { class: 'tool-ask-label', text: `Asked ${msg.agent || 'another agent'}` }),
        msg.threadId && !state.shared ? el('button', {
          class: 'tool-ask-open', type: 'button', text: 'Open thread',
          onclick: ev => { ev.preventDefault(); openConversation(msg.threadId); },
        }) : null,
      ]),
      el('div', { class: 'tool-ask-body' }, [
        msg.prompt ? el('div', { class: 'tool-ask-prompt', text: msg.prompt }) : null,
        el('div', { class: 'tool-ask-answer', text: msg.answer || msg.content }),
      ]),
    ]));
    return;
  }
  if (msg.reasoning) {
    body.append(el('details', { class: 'reasoning' }, [
      el('summary', { text: msg.pending ? 'Thinking…' : 'Reasoning' }),
      el('div', { class: 'reasoning-body', text: msg.reasoning }),
    ]));
  }
  if (msg.error) {
    body.append(el('p', { class: 'msg-note', text: msg.error }));
    if (msg.content) body.append(el('div', { html: renderMarkdown(msg.content) }));
    return;
  }

  // Ask blocks are protocol, not prose; what the model actually said is
  // everything around them.
  const visible = splitAskBlocks(msg.content)
    .filter(s => !s.ask).map(s => s.text).join('\n\n').trim();
  const holder = el('div', { html: renderMarkdown(visible) });
  body.append(holder);

  if (msg.pending && !visible) {
    holder.append(el('span', { class: 'caret' }));
  } else if (!visible && !msg.reasoning && !msg.intermediate) {
    // Reasoning models sometimes spend the whole budget thinking and return no
    // answer; without this the message just looks blank.
    body.append(el('p', { class: 'msg-note', text: msg.reasoning
      ? 'Only reasoning came back, no answer. Retry, or raise the token limit.'
      : 'The model returned an empty response.' }));
  }
}

function footNode(msg) {
  const bits = [];
  if (msg.model) bits.push(msg.model);
  if (msg.usage?.completionTokens) bits.push(`${msg.usage.completionTokens} tokens`);
  if (msg.stopped) bits.push('stopped');

  return el('div', { class: 'msg-foot' }, [
    bits.length ? el('span', { class: 'msg-meta', text: bits.join(' · ') }) : el('span', { class: 'msg-meta' }),
    el('button', {
      class: 'msg-action', type: 'button', text: 'Copy',
      onclick: async () => toast(await copyText(msg.content) ? 'Copied' : 'Copy failed'),
    }),
    msg.role === 'user' ? el('button', {
      class: 'msg-action', type: 'button', text: 'Edit', onclick: () => editMessage(msg),
    }) : null,
    msg.role === 'assistant' ? el('button', {
      class: 'msg-action', type: 'button', text: 'Retry', onclick: () => regenerate(msg),
    }) : null,
    el('button', {
      class: 'msg-action danger', type: 'button', text: 'Delete', onclick: () => deleteOneMessage(msg),
    }),
  ]);
}

function welcomeNode() {
  const provider = currentProvider();

  const starters = [
    'Why privacy matters, even if I have nothing to hide',
    'What can a website work out about me from my browser alone?',
    'Explain end-to-end encryption in plain English',
  ];

  // Vendor neutral: the app has no opinion about whose API you point it at, so
  // the empty state says only what is true of every one of them. Which provider
  // and model are in play is already on the chip above the composer.
  const subtitle = provider
    ? 'Your chats and keys are stored only in this browser.'
    : 'Add a provider in Settings to get started.';

  return el('div', { class: 'welcome' }, [
    el('h2', { text: 'Private by default' }),
    el('p', { text: subtitle }),
    ...starters.map(text => el('button', {
      class: 'starter', type: 'button', text,
      onclick: () => { dom.input.value = text; autosize(dom.input); updateSendState(); dom.input.focus(); },
    })),
  ]);
}

function renderMessages(jump = false) {
  const scroller = clear(dom.messages);
  if (state.shared) {
    // Read-only transcript: same message styling, no actions, no composer.
    scroller.append(el('div', { class: 'thread' }, state.shared.messages.map(previewNode)));
    if (jump || state.pinned) scrollToBottom();
    return;
  }
  if (!state.messages.length) {
    scroller.append(welcomeNode());
    dom.jump.hidden = true;
    return;
  }
  const thread = el('div', { class: 'thread' });
  for (const msg of state.messages) thread.append(messageNode(msg));
  scroller.append(thread);
  if (jump || state.pinned) scrollToBottom();
}

function appendMessage(msg) {
  let thread = $('.thread', dom.messages);
  if (!thread) {
    thread = el('div', { class: 'thread' });
    clear(dom.messages).append(thread);
  }
  thread.append(messageNode(msg));
  scrollToBottom();
}

const nodeFor = id => $(`.msg[data-id="${id}"]`, dom.messages);

function scrollToBottom() {
  dom.messages.scrollTop = dom.messages.scrollHeight;
  state.pinned = true;
  dom.jump.hidden = true;
}

/* ── sending ───────────────────────────────────────────────── */

const nextSeq = () =>
  state.messages.length ? Math.max(...state.messages.map(m => m.seq || 0)) + 1 : 0;

function historyForRequest() {
  const usable = state.messages.filter(m => !m.error && m.content && m.role !== 'system');
  const limit = agentOf(state.conv)?.historyLimit ?? state.conv?.historyLimit;
  const slice = limit > 0 ? usable.slice(-limit) : usable;
  // A tool answer reads to the provider as a user-side note in the
  // conversation; every provider understands that shape.
  return slice.map(m => m.role === 'tool'
    ? { role: 'user', content: `[The ${m.agent || 'agent'} was asked separately and answered:]\n${m.content}` }
    : { role: m.role, content: m.content });
}

async function handleSubmit(ev) {
  ev?.preventDefault();
  // Block only if a stream is running for the current conversation; the
  // composer does not exist at all while a shared chat is being previewed.
  if (state.shared) return;
  if (state.streaming?.convId === state.conv?.id) return;
  const text = dom.input.value.trim();
  if (!text) return;

  const provider = currentProvider();
  if (!provider) { openSettings(shell); return; }

  // The agent owns provider and model; a chat without a usable model gets
  // the agent picker, not a dead end.
  const agent = agentOf(state.conv);
  const model = agent?.model || state.conv.model || provider.defaultModel;
  if (!model) { openAgentPicker(); return; }

  const { encrypted, unlocked } = vault.status();
  if (encrypted && !unlocked) { askUnlock(); return; }

  dom.input.value = '';
  autosize(dom.input);
  updateSendState();

  if (state.conv.draft) {
    state.conv.title = text.replace(/\s+/g, ' ').slice(0, 60) || 'Untitled';
    state.conv.providerId = provider.id;
    state.conv.model = model;
    await persistConversation();
  } else if (state.conv.model !== model || state.conv.providerId !== provider.id) {
    await persistConversation({ model, providerId: provider.id });
  }

  const msg = store.newMessage(state.conv.id, 'user', text, nextSeq());
  state.messages.push(msg);
  await store.putMessage(msg);
  appendMessage(msg);
  renderHeader();

  await runCompletion();
}

async function runCompletion() {
  const convId = state.conv.id;
  const agent = agentOf(state.conv);
  const provider = agent ? (providerById(agent.providerId) || currentProvider()) : currentProvider();
  const model = agent?.model || state.conv.model || provider.defaultModel;

  const controller = new AbortController();
  state.streaming = { controller, id: null, convId };
  setBusy(true);

  // One assistant message per round. Tool answers arrive between rounds as
  // tool messages; the next round sees them through historyForRequest. The
  // reply is done when the model produces a round with no ask blocks.
  let current = null;
  let frame = null;
  const repaint = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      // Only update the DOM if the user is still viewing this conversation.
      if (state.conv?.id !== convId || !current) return;
      // Re-derive the body reference each time — it may have changed
      // if the user navigated away and back.
      const currentBody = $('.prose', nodeFor(current.id));
      if (!currentBody) return;
      paintBody(currentBody, current);
      if (state.pinned) dom.messages.scrollTop = dom.messages.scrollHeight;
    });
  };

  try {
    let ran = 0;   // tool executions so far in this reply
    for (;;) {
      const assistant = store.newMessage(convId, 'assistant', '', nextSeq(), {
        model, providerId: provider.id, pending: true,
      });
      current = assistant;
      state.streaming.id = assistant.id;
      state.messages.push(assistant);
      appendMessage(assistant);
      // Persist early so the message survives a conversation switch.
      await store.putMessage(assistant);

      const result = await api.streamChat({
        provider,
        apiKey: vault.getKey(provider.id),
        model,
        system: (agent
          ? (agent.systemPrompt || '')
          : (state.conv.systemPrompt || state.defaults.systemPrompt || '')) + toolsPrompt(agent),
        messages: historyForRequest(),
        temperature: agent ? agent.temperature : state.conv.temperature,
        maxTokens: agent ? agent.maxTokens : state.conv.maxTokens,
        signal: controller.signal,
        onDelta: ({ text, reasoning }) => {
          assistant.content += text;
          if (reasoning) assistant.reasoning = (assistant.reasoning || '') + reasoning;
          repaint();
        },
      });
      assistant.content = result.text || assistant.content;
      assistant.usage = result.usage;
      delete assistant.pending;
      await store.putMessage(assistant);
      current = null;
      if (state.conv?.id === convId) {
        nodeFor(assistant.id)?.replaceWith(messageNode(assistant));
        if (state.pinned) scrollToBottom();
      }

      // Tools: the reply may delegate questions to other agent threads.
      if (!state.agents.length || agent?.tools === false || ran >= MAX_TOOL_ROUNDS) break;
      const calls = askCalls(assistant.content).slice(0, MAX_TOOL_ROUNDS - ran);
      if (!calls.length) break;
      ran += calls.length;
      // The round's visible text is protocol fragments around the ask blocks;
      // without this it would read as an empty reply.
      assistant.intermediate = true;
      await store.putMessage(assistant);

      for (const call of calls) {
        const run = await executeAskTool(call, controller);   // AbortError escapes
        const toolMsg = store.newMessage(convId, 'tool',
          // The content is what historyForRequest feeds back; an empty answer
          // has to say so, or the next round never learns the ask happened.
          run.answer || '(The agent returned no text.)', nextSeq(), {
          agent: run.agentName, agentId: run.agentId, prompt: run.prompt,
          threadId: run.threadId,
        });
        state.messages.push(toolMsg);
        if (state.conv?.id === convId) appendMessage(toolMsg);
        await store.putMessage(toolMsg);
      }
    }
  } catch (err) {
    const assistant = current;
    if (assistant) {
      if (err.name === 'AbortError') {
        assistant.stopped = true;
      } else {
        assistant.error = err.message || String(err);
        toast(assistant.error, 'err', 9000);
      }
      delete assistant.pending;
      await store.putMessage(assistant);
      if (state.conv?.id === convId) {
        nodeFor(assistant.id)?.replaceWith(messageNode(assistant));
        if (state.pinned) scrollToBottom();
      }
    }
  } finally {
    if (frame) cancelAnimationFrame(frame);
    const isCurrent = state.conv?.id === convId;
    if (state.streaming?.convId === convId) state.streaming = null;
    if (isCurrent) setBusy(false);
    // Persist the conversation the stream belongs to, not whatever conv is active now.
    const conv = state.conversations.find(c => c.id === convId);
    if (conv) {
      Object.assign(conv, { updatedAt: Date.now() });
      const { draft, ...record } = conv;
      await store.putConversation(record);
      await refreshConversations();
    }
    if (isCurrent && state.pinned) scrollToBottom();
  }
}

function setBusy(busy) {
  dom.send.hidden = busy;
  dom.stop.hidden = !busy;
  dom.input.setAttribute('aria-busy', busy ? 'true' : 'false');
}

function updateSendState() {
  dom.send.disabled = !dom.input.value.trim();
}

function stopStreaming() {
  if (!state.streaming) return;
  state.streaming.controller.abort();
  state.streaming = null;
  setBusy(false);
}

/** Detach the active stream from the UI so it finishes in the background.
 *  The stream continues and the message is saved when it completes,
 *  but the UI shows the new conversation without the spinner. */
function detachStreaming() {
  if (!state.streaming) return;
  setBusy(false);
}

async function truncateFrom(index) {
  const removed = state.messages.slice(index);
  state.messages = state.messages.slice(0, index);
  await store.deleteMessages(removed.map(m => m.id));
}

async function regenerate(msg) {
  if (state.streaming?.convId === state.conv?.id) return;
  const index = state.messages.findIndex(m => m.id === msg.id);
  if (index < 0) return;
  await truncateFrom(index);
  renderMessages();
  await runCompletion();
}

async function editMessage(msg) {
  if (state.streaming?.convId === state.conv?.id) return;
  const text = await promptText({ title: 'Edit message', value: msg.content, multiline: true });
  if (text === null || text === msg.content) return;
  const index = state.messages.findIndex(m => m.id === msg.id);
  await truncateFrom(index + 1);
  msg.content = text;
  await store.putMessage(msg);
  renderMessages();
  await runCompletion();
}

async function deleteOneMessage(msg) {
  if (state.streaming?.convId === state.conv?.id) return;
  state.messages = state.messages.filter(m => m.id !== msg.id);
  await store.deleteMessage(msg.id);
  renderMessages();
}

/* ── sheets owned by the chat screen ───────────────────────── */

function openAgentPicker() {
  openSheet({ title: 'Agents', render: agentsScreen });
}

function agentsScreen() {
  const current = agentOf(state.conv);
  const rows = state.agents.map(agent => {
    const provider = providerById(agent.providerId);
    return el('button', {
      class: `item${current?.id === agent.id ? ' is-active' : ''}`,
      type: 'button',
      // An agent without a model cannot answer yet; picking it opens the
      // editor instead of pointing a chat at a dead end.
      onclick: () => agent.model
        ? useAgent(agent)
        : pushScreen({ title: agent.name, render: () => agentEditorScreen(agent) }),
    }, [
      el('span', { class: 'item-main' }, [
        el('span', { class: 'item-title', text: agent.name }),
        el('span', { class: 'item-sub',
          text: `${provider?.name || 'No provider'} · ${agent.model || 'no model yet'}` }),
      ]),
      el('span', { class: 'item-check', text: current?.id === agent.id ? '✓' : '' }),
    ]);
  });
  if (!rows.length) rows.push(el('div', { class: 'item' }, [
    el('span', { class: 'item-main' }, [el('span', { class: 'item-title', text: 'No agents yet' })]),
  ]));

  return el('div', {}, [
    el('div', { class: 'group' }, [el('div', { class: 'item-list' }, rows)]),
    el('div', { class: 'group' }, [
      el('div', { class: 'item-list' }, [
        el('button', { class: 'item', type: 'button',
          onclick: () => pushScreen({ title: 'New agent', render: () => agentEditorScreen(null) }),
        }, [
          el('span', { class: 'item-main' }, [el('span', { class: 'item-title', text: 'New agent' })]),
          el('span', { class: 'item-chevron', text: '›' }),
        ]),
        state.agents.length ? el('button', { class: 'item', type: 'button', onclick: editAgentPrompt }, [
          el('span', { class: 'item-main' }, [el('span', { class: 'item-title', text: 'Edit an agent' })]),
          el('span', { class: 'item-chevron', text: '›' }),
        ]) : null,
        el('button', { class: 'item', type: 'button', onclick: () => openSettings(shell) }, [
          el('span', { class: 'item-main' }, [el('span', { class: 'item-title', text: 'Manage providers' })]),
          el('span', { class: 'item-chevron', text: '›' }),
        ]),
      ]),
    ]),
  ]);
}

async function editAgentPrompt() {
  const id = await chooseFromList({
    title: 'Edit an agent',
    items: state.agents.map(a => ({
      value: a.id,
      label: a.name,
      sub: `${providerById(a.providerId)?.name || 'No provider'} · ${a.model || 'no model'}`,
    })),
    selected: agentOf(state.conv)?.id,
  });
  if (!id) return;
  const agent = agentById(id);
  if (agent) pushScreen({ title: agent.name, render: () => agentEditorScreen(agent) });
}

/** Point the current chat at an agent. The chat's own provider/model fields
    are kept in step so exports, duplicates and legacy fallbacks stay true. */
async function useAgent(agent) {
  if (!state.conv) return;
  state.conv.agentId = agent.id;
  state.conv.providerId = agent.providerId;
  state.conv.model = agent.model;
  saveUI({ lastAgentId: agent.id });
  if (!state.conv.draft) await persistConversation();
  updateChip();
  closeSheet();
}

function agentEditorScreen(agent) {
  const isNew = !agent;
  const draft = agent ? { ...agent } : {
    id: null, name: '', providerId: null, model: '',
    systemPrompt: state.defaults.systemPrompt || '',
    temperature: state.defaults.temperature,
    maxTokens: state.defaults.maxTokens,
    historyLimit: state.defaults.historyLimit,
  };
  if (isNew && !draft.providerId && state.providers[0]) {
    draft.providerId = state.providers[0].id;
    draft.name = state.providers[0].name;
  }

  const nameInput = el('input', {
    class: 'form-control', type: 'text', value: draft.name, placeholder: 'Name',
    onchange: ev => { draft.name = ev.target.value.trim(); },
  });

  const providerRow = el('button', {
    class: 'item', type: 'button',
    onclick: async () => {
      const id = await chooseFromList({
        title: 'Provider',
        items: state.providers.map(p => ({ value: p.id, label: p.name, sub: p.baseUrl || 'No address set' })),
        selected: draft.providerId,
      });
      if (!id || id === draft.providerId) return;
      draft.providerId = id;
      draft.model = '';   // a model from the old provider means nothing here
      refreshSheet();
    },
  }, [
    el('span', { class: 'item-main' }, [el('span', { class: 'item-title', text: 'Provider' })]),
    el('span', { class: 'item-value', text: providerById(draft.providerId)?.name || 'None' }),
    el('span', { class: 'item-chevron', text: '›' }),
  ]);

  const modelRow = el('button', {
    class: 'item', type: 'button',
    onclick: async () => {
      const provider = providerById(draft.providerId);
      if (!provider) { toast('Pick a provider first', 'err'); return; }
      const model = await chooseModel(provider, draft.model, 'Model');
      if (!model) return;
      draft.model = model;
      refreshSheet();
    },
  }, [
    el('span', { class: 'item-main' }, [el('span', { class: 'item-title', text: 'Model' })]),
    el('span', { class: 'item-value', text: draft.model || 'Not set' }),
    el('span', { class: 'item-chevron', text: '›' }),
  ]);

  const sys = el('textarea', {
    class: 'form-control', rows: 5, value: draft.systemPrompt || '',
    placeholder: 'You are a helpful assistant.',
    onchange: ev => { draft.systemPrompt = ev.target.value; },
  });

  const temp = el('input', {
    class: 'form-range', type: 'range', min: 0, max: 2, step: 0.05,
    value: draft.temperature ?? 0.7,
  });
  const tempValue = el('span', { class: 'item-value', text: Number(draft.temperature ?? 0.7).toFixed(2) });
  temp.addEventListener('input', () => { tempValue.textContent = Number(temp.value).toFixed(2); });
  temp.addEventListener('change', () => { draft.temperature = Number(temp.value); });

  const maxTokensInput = el('input', {
    class: 'form-control', type: 'number', min: 1, step: 1,
    value: draft.maxTokens ?? '', placeholder: 'Provider default',
    onchange: ev => { draft.maxTokens = ev.target.value ? Number(ev.target.value) : null; },
  });

  const toolsSwitch = el('input', {
    class: 'form-check-input', type: 'checkbox',
    checked: draft.tools !== false,
    onchange: ev => { draft.tools = ev.target.checked; },
  });

  const save = async () => {
    draft.name = draft.name || providerById(draft.providerId)?.name || 'Agent';
    if (!draft.providerId) { toast('Pick a provider', 'err'); return; }
    if (!draft.model) { toast('Pick a model', 'err'); return; }
    if (isNew) {
      const created = { ...draft, id: store.uid() };
      state.agents.push(created);
      saveUI({ lastAgentId: created.id });
    } else {
      Object.assign(agent, draft);
    }
    await saveAgents();
    toast(isNew ? 'Agent created' : 'Agent saved', 'ok');
    updateChip();
    popScreen();
  };

  return el('div', {}, [
    el('div', { class: 'group' }, [
      el('div', { class: 'item' }, [field('Name', nameInput)]),
      providerRow,
      modelRow,
    ]),
    el('div', { class: 'group' }, [
      el('div', { class: 'field' }, [
        el('label', { class: 'field-label', text: 'System prompt' }),
        sys,
      ]),
    ]),
    el('div', { class: 'group' }, [
      el('div', { class: 'item-list' }, [
        el('div', { class: 'item' }, [
          el('span', { class: 'item-main' }, [
            el('span', { class: 'item-title', text: 'Temperature' }),
            temp,
          ]),
          tempValue,
        ]),
      ]),
    ]),
    el('div', { class: 'group' }, [
      el('div', { class: 'field' }, [
        el('label', { class: 'field-label', text: 'Max tokens' }),
        maxTokensInput,
      ]),
    ]),
    el('div', { class: 'group' }, [
      el('div', { class: 'item-list' }, [
        el('div', { class: 'item' }, [
          el('label', { class: 'form-check form-switch w-100' }, [
            el('span', { class: 'form-check-label', text: 'Can ask other agents' }),
            toolsSwitch,
          ]),
        ]),
      ]),
    ], 'Lets the model delegate a question to another agent as its own thread.'),
    el('div', { class: 'sheet-actions' }, [
      el('button', { class: 'btn btn-primary btn-block', type: 'button',
                    text: isNew ? 'Create agent' : 'Save agent', onclick: save }),
    ]),
    isNew ? null : el('div', { class: 'group' }, [
      el('div', { class: 'item-list' }, [
        el('button', { class: 'item danger', type: 'button',
                      onclick: () => deleteAgentFlow(agent) }, [
          el('span', { class: 'item-main' }, [el('span', { class: 'item-title', text: 'Delete agent' })]),
        ]),
      ]),
    ]),
  ]);
}

async function deleteAgentFlow(agent) {
  const ok = await confirmAction({
    title: `Delete ${agent.name}?`,
    body: 'Chats that used it keep a snapshot of its settings and carry on with those.',
    okText: 'Delete',
  });
  if (!ok) return;
  state.agents = state.agents.filter(a => a.id !== agent.id);
  await saveAgents();
  if (state.ui.lastAgentId === agent.id) {
    saveUI({ lastAgentId: state.agents[0]?.id ?? null });
  }
  for (const c of state.conversations) {
    if (c.agentId !== agent.id) continue;
    snapshotAgent(c, agent);
    await store.putConversation(c);
    if (state.conv?.id === c.id) snapshotAgent(state.conv, agent);
  }
  if (state.conv?.agentId === agent.id) snapshotAgent(state.conv, agent);
  updateChip();
  renderConvList();
  popScreen();
  toast('Agent deleted');
}

function openChatMenu() {
  if (!state.conv) return;
  openSheet({ title: state.conv.title || 'New chat', render: chatMenuScreen });
}

function chatMenuScreen() {
  const row = (title, onclick, danger) => el('button', {
    class: `item${danger ? ' danger' : ''}`, type: 'button', onclick,
  }, [el('span', { class: 'item-main' }, [el('span', { class: 'item-title', text: title })])]);

  return el('div', {}, [
    el('div', { class: 'group' }, [
      el('div', { class: 'item-list' }, [
        row('Rename', renameChat),
        row('Chat settings', () => pushScreen({ title: 'Chat settings', render: chatSettingsScreen })),
        row('Duplicate', duplicateChat),
      ]),
    ]),
    el('div', { class: 'group' }, [
      el('div', { class: 'item-list' }, [
        row('Share link', openShare),
        row('Export as JSON', () => exportChat('json')),
        row('Export as Markdown', () => exportChat('md')),
      ]),
    ]),
    el('div', { class: 'group' }, [
      el('div', { class: 'item-list' }, [
        row('Clear messages', clearChat, true),
        row('Delete chat', deleteChat, true),
      ]),
    ]),
  ]);
}

function chatSettingsScreen() {
  const conv = state.conv;
  const agent = agentOf(conv);

  if (agent) {
    const provider = providerById(agent.providerId);
    return el('div', {}, [
      el('div', { class: 'group' }, [
        el('div', { class: 'item-list' }, [
          el('div', { class: 'item' }, [
            el('span', { class: 'item-main' }, [
              el('span', { class: 'item-title', text: 'Agent' }),
              el('span', { class: 'item-sub',
                text: `${provider?.name || 'No provider'} · ${agent.model || 'no model'}` }),
            ]),
            el('span', { class: 'item-value', text: agent.name }),
          ]),
          el('button', { class: 'item', type: 'button',
            onclick: () => pushScreen({ title: 'Agents', render: agentsScreen }),
          }, [
            el('span', { class: 'item-main' }, [el('span', { class: 'item-title', text: 'Change agent' })]),
            el('span', { class: 'item-chevron', text: '›' }),
          ]),
          el('button', { class: 'item', type: 'button',
            onclick: () => pushScreen({ title: agent.name, render: () => agentEditorScreen(agent) }),
          }, [
            el('span', { class: 'item-main' }, [
              el('span', { class: 'item-title', text: 'Edit agent' }),
              el('span', { class: 'item-sub', text: 'Applies to every chat using it' }),
            ]),
            el('span', { class: 'item-chevron', text: '›' }),
          ]),
        ]),
      ], `This chat speaks through ${agent.name}. Its prompt, model and sampling come from the agent.`),
    ]);
  }

  // A chat from before agents keeps its own settings until an agent is chosen.
  const save = async patch => {
    Object.assign(conv, patch);
    if (!conv.draft) await persistConversation(patch);
  };

  const sys = el('textarea', {
    class: 'form-control', rows: 5, value: conv.systemPrompt || '',
    placeholder: 'You are a helpful assistant.',
    onchange: ev => save({ systemPrompt: ev.target.value }),
  });
  const temp = el('input', {
    class: 'form-range', type: 'range', min: 0, max: 2, step: 0.05,
    value: conv.temperature ?? 0.7,
  });
  const tempValue = el('span', { class: 'item-value', text: Number(conv.temperature ?? 0.7).toFixed(2) });
  temp.addEventListener('input', () => { tempValue.textContent = Number(temp.value).toFixed(2); });
  temp.addEventListener('change', () => save({ temperature: Number(temp.value) }));

  const num = (value, placeholder, key) => el('input', {
    class: 'form-control', type: 'number', min: 1, step: 1, value: value ?? '', placeholder,
    onchange: ev => save({ [key]: ev.target.value ? Number(ev.target.value) : null }),
  });

  return el('div', {}, [
    el('div', { class: 'group' }, [
      el('div', { class: 'item-list' }, [
        el('button', { class: 'item', type: 'button',
          onclick: () => pushScreen({ title: 'Agents', render: agentsScreen }),
        }, [
          el('span', { class: 'item-main' }, [
            el('span', { class: 'item-title', text: 'Use an agent instead' }),
            el('span', { class: 'item-sub', text: 'Prompt, model and settings from a named agent' }),
          ]),
          el('span', { class: 'item-chevron', text: '›' }),
        ]),
      ]),
    ]),
    el('div', { class: 'group' }, [
      el('div', { class: 'field' }, [
        el('label', { class: 'field-label', text: 'System prompt' }),
        sys,
      ]),
    ]),
    el('div', { class: 'group' }, [
      el('div', { class: 'item-list' }, [
        el('div', { class: 'item' }, [
          el('span', { class: 'item-main' }, [
            el('span', { class: 'item-title', text: 'Temperature' }),
            temp,
          ]),
          tempValue,
        ]),
      ]),
    ]),
    el('div', { class: 'group' }, [
      el('div', { class: 'field' }, [
        el('label', { class: 'field-label', text: 'Max tokens' }),
        num(conv.maxTokens, 'Provider default', 'maxTokens'),
      ]),
      el('div', { class: 'field' }, [
        el('label', { class: 'field-label', text: 'Messages sent' }),
        num(conv.historyLimit, 'All of them', 'historyLimit'),
      ]),
    ]),
    el('div', { class: 'group' }, [
      el('div', { class: 'item-list' }, [
        el('button', {
          class: 'item', type: 'button',
          onclick: async () => {
            state.defaults = {
              ...state.defaults,
              systemPrompt: conv.systemPrompt,
              temperature: conv.temperature,
              maxTokens: conv.maxTokens,
              historyLimit: conv.historyLimit,
            };
            await store.kvSet('defaults', state.defaults);
            toast('Saved as the default for new chats', 'ok');
          },
        }, [el('span', { class: 'item-main' }, [
          el('span', { class: 'item-title', text: 'Use these for new chats too' }),
        ])]),
      ]),
    ]),
  ]);
}

async function renameChat() {
  const title = await promptText({ title: 'Rename chat', value: state.conv.title });
  if (title === null) return;
  state.conv.title = title || 'Untitled';
  if (!state.conv.draft) await persistConversation();
  renderHeader();
  renderConvList();
  closeSheet();
}

async function duplicateChat() {
  if (state.conv.draft) { toast('Nothing to duplicate yet'); return; }
  const copy = {
    ...state.conv, id: store.uid(), title: `${state.conv.title} (copy)`,
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  delete copy.draft;
  await store.putConversation(copy);
  for (const m of state.messages) await store.putMessage({ ...m, id: store.uid(), convId: copy.id });
  await refreshConversations();
  await openConversation(copy.id);
  closeSheet();
  toast('Chat duplicated');
}

const slug = s => (s || 'chat').toLowerCase().replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '').slice(0, 48) || 'chat';

function exportChat(kind) {
  if (kind === 'json') {
    const { draft, ...conv } = state.conv;
    downloadJSON(`${slug(conv.title)}.json`, {
      app: 'ivx-ai-chat', version: 1, exportedAt: new Date().toISOString(),
      conversation: conv, messages: state.messages,
    });
  } else {
    const lines = [`# ${state.conv.title || 'Chat'}`, ''];
    for (const m of state.messages) {
      const who = m.role === 'user' ? 'You'
        : m.role === 'tool' ? `Asked ${m.agent || 'another agent'}`
        : 'Assistant';
      lines.push(`## ${who}`, '', (m.role === 'tool' ? (m.answer || m.content) : m.content) || '', '');
    }
    downloadBlob(`${slug(state.conv.title)}.md`, new Blob([lines.join('\n')], { type: 'text/markdown' }));
  }
  closeSheet();
}

/* ── share links ───────────────────────────────────────────── */

async function openShare() {
  if (!state.messages.length) { toast('Nothing to share yet', 'err'); return; }
  // A reply still being written is not part of the chat yet — leaving it out
  // keeps "what the link says" and "what the chat says" the same thing.
  const messages = state.messages.filter(m => !m.pending);
  let url;
  try {
    const { draft, ...conv } = state.conv;
    url = await share.buildLink({ conversation: conv, messages });
  } catch (err) {
    toast(err.message || 'Could not build the share link', 'err');
    return;
  }
  pushScreen({ title: 'Share link', render: () => shareScreen(url) });
}

function shareScreen(url) {
  const kb = Math.round(url.length / 102.4) / 10;
  // is.gd — the most permissive shortener here — draws the line at 5,000
  // characters; past that the automatic shortening cannot work at all.
  const hint = url.length > 5000
    ? 'Longer than is.gd accepts (5,000 characters), so the shortener will refuse. Export a file instead.'
    : url.length > 2000 ? 'Long links like this are refused by some shorteners.' : '';

  const result = el('div');
  const shortenBtn = el('button', {
    class: 'btn btn-primary btn-block', type: 'button', text: 'Shorten the link',
    onclick: async () => {
      shortenBtn.disabled = true;
      shortenBtn.textContent = 'Shortening…';
      try {
        const { short, name } = await share.shortenUrl(url);
        clear(result);
        result.append(
          el('div', { class: 'field' }, [
            el('input', { class: 'form-control', readOnly: true, value: short,
                          'aria-label': 'Short link', onclick: ev => ev.target.select() }),
          ]),
          el('div', { class: 'sheet-actions' }, [
            el('button', { class: 'btn btn-primary btn-block', type: 'button', text: 'Copy short link',
                          onclick: async () => toast(await copyText(short) ? 'Copied' : 'Copy failed') }),
          ]),
          el('p', { class: 'group-note', text: `Shortened with ${name}.` }),
        );
      } catch (err) {
        clear(result);
        result.append(
          el('p', { class: 'group-note', text: err.message }),
          el('div', { class: 'sheet-actions' }, [
            el('button', { class: 'btn btn-secondary btn-block', type: 'button',
                          text: 'Open TinyURL with this link pre-filled',
                          onclick: () => window.open(`https://tinyurl.com/create.php?url=${encodeURIComponent(url)}`, '_blank', 'noopener') }),
          ]),
        );
      }
    },
  });

  return el('div', {}, [
    el('p', { class: 'group-note', text: 'The whole conversation is zipped and encoded into this link. The app uploads nothing — but anyone who has the link, including a shortener, can read the chat.' }),
    el('div', { class: 'field' }, [
      el('textarea', { class: 'form-control', rows: 4, readOnly: true, value: url,
                      'aria-label': 'Share link', onclick: ev => ev.target.select() }),
    ]),
    el('div', { class: 'sheet-actions' }, [
      el('button', { class: 'btn btn-secondary btn-block', type: 'button', text: 'Copy link',
                    onclick: async () => toast(await copyText(url) ? 'Copied' : 'Copy failed') }),
    ]),
    el('p', { class: 'group-note', text: `${url.length} characters (~${kb} KB).${hint ? ' ' + hint : ''}` }),
    el('p', { class: 'group-note', text: 'Chat links are usually too long to paste around. A shortener trims them down — it will see the chat, since the chat rides inside the URL.' }),
    shortenBtn,
    result,
  ]);
}

/** A read-only look at one message: body only. The action buttons a saved
    message carries make no sense for a chat nobody owns yet. */
function previewNode(msg) {
  const body = msg.role === 'user' ? el('div', { class: 'bubble' }) : el('div', { class: 'prose' });
  paintBody(body, msg);
  return el('article', { class: `msg msg-${msg.role}${msg.error ? ' msg-error' : ''}` }, [body]);
}

/** A share link in the URL is a chat to look at first. Nothing is saved and
    no conversation is loaded; the hash is scrubbed either way, so a refresh
    neither re-asks nor duplicates — and walking away discards the chat. */
async function acceptSharedLink() {
  if (!location.hash.startsWith('#s=')) return null;
  const bundle = await share.readSharedLink();
  history.replaceState(null, '', location.pathname + location.search);
  if (!bundle) { toast('This share link could not be decoded', 'err'); return null; }
  return bundle;
}

async function clearChat() {
  const ok = await confirmAction({
    title: 'Clear messages?', body: 'The chat stays, its messages go.', okText: 'Clear',
  });
  if (!ok) return;
  stopStreaming();
  if (!state.conv.draft) await store.clearMessages(state.conv.id);
  state.messages = [];
  renderMessages();
  closeSheet();
}

async function deleteChat() {
  if (state.conv.draft) { startDraft(); closeSheet(); return; }
  const ok = await confirmAction({
    title: 'Delete chat?',
    body: `“${state.conv.title || 'Untitled'}” and its messages will be removed from this browser.`,
    okText: 'Delete',
  });
  if (!ok) return;
  await store.deleteConversation(state.conv.id);
  startDraft();
  await refreshConversations();
  closeSheet();
  toast('Chat deleted');
}

async function askUnlock() {
  for (;;) {
    const pass = await promptText({
      title: 'Unlock your keys',
      placeholder: 'Passphrase',
      type: 'password',
      okText: 'Unlock',
    });
    if (pass === null) return false;
    try {
      await vault.unlock(pass);
      updateChip();
      warmModels(currentProvider());
      toast('Keys unlocked', 'ok');
      return true;
    } catch (err) {
      toast(err.message, 'err');
    }
  }
}

/* ── what settings.js calls back into ──────────────────────── */

const shell = {
  getProviders: () => state.providers,
  saveProviders,
  getAgents: () => state.agents,
  saveAgents,
  attachDefaultAgent,
  forgetProvider,
  agentScreens: {
    picker: () => ({ title: 'Agents', render: agentsScreen }),
    editor: agent => ({ title: agent ? agent.name : 'New agent', render: () => agentEditorScreen(agent) }),
  },
  getUI: () => state.ui,
  setUI: saveUI,
  applyAppearance,
  askUnlock,
  refreshChrome: () => {
    updateChip();
    renderConvList();
    if (!state.messages.length) renderMessages();
  },
  reloadData: async () => {
    state.providers = await store.kvGet('providers', state.providers);
    state.agents = await store.kvGet('agents', state.agents);
    state.defaults = { ...DEFAULTS, ...(await store.kvGet('defaults', {})) };
    await refreshConversations();
    updateChip();
  },
  deleteAllChats: async () => {
    stopStreaming();
    await store.deleteAllConversations();
    await refreshConversations();
    startDraft();
  },
};

/* ── events ────────────────────────────────────────────────── */

const openDrawer = () => dom.app.classList.add('drawer-open');
const closeDrawer = () => dom.app.classList.remove('drawer-open');

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function bindEvents() {
  $('#composer').addEventListener('submit', handleSubmit);
  dom.stop.addEventListener('click', stopStreaming);
  $('#btnAddShared').addEventListener('click', addSharedChat);

  dom.input.addEventListener('input', () => { autosize(dom.input); updateSendState(); });
  dom.input.addEventListener('keydown', ev => {
    if (ev.key !== 'Enter' || ev.isComposing) return;
    const send = state.ui.sendOnEnter ? !ev.shiftKey : (ev.metaKey || ev.ctrlKey);
    if (send) { ev.preventDefault(); handleSubmit(); }
  });
  updateSendState();

  $('#btnMenu').addEventListener('click', openDrawer);
  $('#btnCloseDrawer').addEventListener('click', closeDrawer);
  $('#scrim').addEventListener('click', closeDrawer);
  $('#btnNewChat').addEventListener('click', () => { startDraft(); closeDrawer(); dom.input.focus(); });
  $('#btnChatMenu').addEventListener('click', openChatMenu);
  $('#btnSettings').addEventListener('click', () => { closeDrawer(); openSettings(shell); });
  $('#btnDisclaimer').addEventListener('click', () => openDisclaimer());
  dom.chip.addEventListener('click', openAgentPicker);
  $('#btnJump').addEventListener('click', scrollToBottom);

  dom.search.addEventListener('input', debounce(async ev => {
    const q = ev.target.value.trim().toLowerCase();
    state.searchHits = null;
    if (q.length >= 2) {
      const all = await store.allMessages();
      state.searchHits = new Set(
        all.filter(m => (m.content || '').toLowerCase().includes(q)).map(m => m.convId)
      );
    }
    renderConvList();
  }, 180));

  dom.messages.addEventListener('scroll', () => {
    const gap = dom.messages.scrollHeight - dom.messages.scrollTop - dom.messages.clientHeight;
    state.pinned = gap < 80;
    const count = state.shared ? state.shared.messages.length : state.messages.length;
    dom.jump.hidden = state.pinned || !count;
  });

  // Tapping a message reveals its meta and actions; everything stays hidden
  // until then so the thread reads as plain conversation.
  dom.messages.addEventListener('click', async ev => {
    const copyBtn = ev.target.closest('[data-copy]');
    if (copyBtn) {
      const code = copyBtn.closest('.code-block')?.querySelector('code');
      if (!code) return;
      const ok = await copyText(code.textContent);
      copyBtn.textContent = ok ? 'Copied' : 'Failed';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
      return;
    }
    if (ev.target.closest('a, button, summary, .msg-foot')) return;
    const msg = ev.target.closest('.msg');
    if (!msg) return;
    const open = msg.classList.contains('is-open');
    for (const other of dom.messages.querySelectorAll('.msg.is-open')) other.classList.remove('is-open');
    if (!open) msg.classList.add('is-open');
  });

  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && dom.app.classList.contains('drawer-open')) closeDrawer();
  });

  window.addEventListener('beforeunload', ev => {
    if (state.streaming) { ev.preventDefault(); ev.returnValue = ''; }
  });
}

/* ── go ────────────────────────────────────────────────────── */

boot().catch(err => {
  console.error(err);
  document.body.prepend(el('div', {
    class: 'group-note',
    text: `ivx/ai Chat failed to start: ${err.message}`,
  }));
});
