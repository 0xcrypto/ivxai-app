// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* NilgAI UI — a local-only AI chat client.

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
import { renderMarkdown } from './markdown.js';
import { openSettings, openIntro } from './settings.js';
import {
  $, el, clear, toast, initSheet, openSheet, pushScreen, closeSheet, refreshSheet,
  confirmAction, promptText, copyText, downloadJSON, downloadBlob, groupLabel, autosize,
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
  defaults: { ...DEFAULTS },
  conversations: [],
  conv: null,
  messages: [],
  streaming: null,
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
    status: $('#statusLine'),
    jump: $('#jump'),
  });

  initSheet();
  applyAppearance();

  const ready = await vault.init();
  state.providers = await store.kvGet('providers', []);
  state.defaults = { ...DEFAULTS, ...(await store.kvGet('defaults', {})) };

  if (!state.providers.length) {
    // Local runtimes first — they work with no key and no account.
    state.providers = ['ollama', 'lmstudio', 'openrouter']
      .map(key => api.makeProvider(api.PRESETS.find(p => p.key === key)));
    await saveProviders();
  }

  bindEvents();
  await refreshConversations();

  const last = state.ui.lastConvId && state.conversations.find(c => c.id === state.ui.lastConvId);
  if (last) await openConversation(last.id);
  else startDraft();

  // First run gets the introduction; a returning user with a locked vault gets
  // the unlock prompt. Never both — one sheet at a time.
  const greeted = await greetOnFirstVisit();
  if (!ready && !greeted) askUnlock();

  registerServiceWorker();
}

/** Returns true when the welcome sheet was shown. */
async function greetOnFirstVisit() {
  if (await store.kvGet('welcomeSeenAt')) return false;
  // Recorded before it is dismissed, so a reload does not show it twice.
  await store.kvSet('welcomeSeenAt', Date.now());
  openIntro(bridge);
  return true;
}

function registerServiceWorker() {
  // Skipped in dev: the precache manifest is stamped in at build time, and a
  // caching worker in front of the dev server only causes confusion.
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).then(reg => {
    reg.addEventListener('updatefound', () => {
      const installing = reg.installing;
      installing?.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          toast('A new version is ready — reload to use it', '', 9000);
        }
      });
    });
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

function updateChip() {
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
  const provider = state.providers[0] || null;
  state.conv = {
    ...store.newConversation({
      ...state.defaults,
      providerId: provider?.id ?? null,
      model: provider?.defaultModel || '',
    }),
    draft: true,
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
  stopStreaming();
  state.conv = conv;
  state.messages = await store.listMessages(id);
  saveUI({ lastConvId: id });
  renderConvList();
  renderHeader();
  renderMessages(true);
  warmModels(currentProvider());
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
  dom.title.textContent = state.conv?.title || 'New chat';
  updateChip();
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

  const holder = el('div', { html: renderMarkdown(msg.content) });
  body.append(holder);

  if (msg.pending && !msg.content) {
    holder.append(el('span', { class: 'caret' }));
  } else if (!msg.content) {
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
  const limit = state.conv?.historyLimit;
  const slice = limit > 0 ? usable.slice(-limit) : usable;
  return slice.map(m => ({ role: m.role, content: m.content }));
}

async function handleSubmit(ev) {
  ev?.preventDefault();
  if (state.streaming) return;
  const text = dom.input.value.trim();
  if (!text) return;

  const provider = currentProvider();
  if (!provider) { openSettings(bridge); return; }

  const model = state.conv.model || provider.defaultModel;
  if (!model) { openModelPicker(); return; }

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
  const provider = currentProvider();
  const model = state.conv.model || provider.defaultModel;
  const assistant = store.newMessage(state.conv.id, 'assistant', '', nextSeq(), {
    model, providerId: provider.id, pending: true,
  });
  state.messages.push(assistant);
  appendMessage(assistant);

  const body = $('.prose', nodeFor(assistant.id));
  const controller = new AbortController();
  state.streaming = { controller, id: assistant.id };
  setBusy(true);

  let frame = null;
  const repaint = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      paintBody(body, assistant);
      if (state.pinned) dom.messages.scrollTop = dom.messages.scrollHeight;
    });
  };

  const started = performance.now();
  try {
    const result = await api.streamChat({
      provider,
      apiKey: vault.getKey(provider.id),
      model,
      system: state.conv.systemPrompt || state.defaults.systemPrompt || '',
      messages: historyForRequest(),
      temperature: state.conv.temperature,
      maxTokens: state.conv.maxTokens,
      signal: controller.signal,
      onDelta: ({ text, reasoning }) => {
        assistant.content += text;
        if (reasoning) assistant.reasoning = (assistant.reasoning || '') + reasoning;
        repaint();
      },
    });
    assistant.content = result.text || assistant.content;
    assistant.usage = result.usage;
    const secs = ((performance.now() - started) / 1000).toFixed(1);
    dom.status.textContent = `${model} · ${secs}s`;
  } catch (err) {
    if (err.name === 'AbortError') {
      assistant.stopped = true;
      dom.status.textContent = 'Stopped';
    } else {
      assistant.error = err.message || String(err);
      dom.status.textContent = '';
      toast(assistant.error, 'err', 9000);
    }
  } finally {
    delete assistant.pending;
    if (frame) cancelAnimationFrame(frame);
    state.streaming = null;
    setBusy(false);
    await store.putMessage(assistant);
    await persistConversation();
    nodeFor(assistant.id)?.replaceWith(messageNode(assistant));
    if (state.pinned) scrollToBottom();
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
}

async function truncateFrom(index) {
  const removed = state.messages.slice(index);
  state.messages = state.messages.slice(0, index);
  await store.deleteMessages(removed.map(m => m.id));
}

async function regenerate(msg) {
  if (state.streaming) return;
  const index = state.messages.findIndex(m => m.id === msg.id);
  if (index < 0) return;
  await truncateFrom(index);
  renderMessages();
  await runCompletion();
}

async function editMessage(msg) {
  if (state.streaming) return;
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
  if (state.streaming) return;
  state.messages = state.messages.filter(m => m.id !== msg.id);
  await store.deleteMessage(msg.id);
  renderMessages();
}

/* ── sheets owned by the chat screen ───────────────────────── */

function openModelPicker() {
  openSheet({ title: 'Model', render: modelScreen });
}

/** Provider id -> why its model list could not be fetched. */
const listErrors = new Map();

async function useModel(provider, model) {
  state.conv.providerId = provider.id;
  state.conv.model = model;
  if (!provider.defaultModel) provider.defaultModel = model;
  await saveProviders();
  if (!state.conv.draft) await persistConversation();
  updateChip();
  closeSheet();
}

async function loadModelList(provider) {
  const busy = toast(`Asking ${provider.name}…`, '', 20000);
  try {
    provider.models = await api.listModels(provider, vault.getKey(provider.id));
    if (provider.models.length) listErrors.delete(provider.id);
    else listErrors.set(provider.id, 'That endpoint listed no models.');
    await saveProviders();
  } catch (err) {
    listErrors.set(provider.id, err.message);
  }
  busy.remove();
  refreshSheet();
}

async function typeModelFor(provider) {
  const name = await promptText({
    title: 'Model name',
    placeholder: provider.kind === 'ollama' ? 'llama3.2' : 'gpt-4o-mini',
    okText: 'Use this model',
  });
  if (!name) return;
  api.rememberModel(provider, name);
  await useModel(provider, name);
}

function modelScreen() {
  const current = currentProvider();
  const blocks = [];

  for (const provider of state.providers) {
    const models = api.knownModels(provider);
    const isCurrent = model => provider.id === current?.id && model === state.conv?.model;

    const rows = models.map(model => el('button', {
      class: `item${isCurrent(model) ? ' is-active' : ''}`,
      type: 'button',
      onclick: () => useModel(provider, model),
    }, [
      el('span', { class: 'item-main' }, [el('span', { class: 'item-title', text: model })]),
      el('span', { class: 'item-check', text: isCurrent(model) ? '✓' : '' }),
    ]));

    // Typing a name is always available — a provider with no /models route is
    // perfectly usable, you just have to know what you want.
    rows.push(el('button', {
      class: 'item', type: 'button', onclick: () => typeModelFor(provider),
    }, [
      el('span', { class: 'item-main' }, [
        el('span', { class: 'item-title', text: 'Type a model name' }),
      ]),
      el('span', { class: 'item-chevron', text: '›' }),
    ]));

    // Keyed off fetched models, not known ones: someone who typed a name to get
    // going should still be able to fetch the real list once CORS is sorted.
    if (!(provider.models || []).length) {
      rows.unshift(el('button', {
        class: 'item', type: 'button', onclick: () => loadModelList(provider),
      }, [
        el('span', { class: 'item-main' }, [
          el('span', { class: 'item-title', text: 'Fetch the model list' }),
          el('span', { class: 'item-sub', text: provider.baseUrl || 'No address set' }),
        ]),
      ]));
    }

    const problem = listErrors.get(provider.id);
    blocks.push(el('div', { class: 'group' }, [
      el('div', { class: 'group-label' }, [
        provider.name,
        api.isLocalUrl(provider.baseUrl) ? ' · local' : '',
      ]),
      el('div', { class: 'item-list' }, rows),
      problem
        ? el('div', { class: 'group-note', text: `${problem} Type the model name instead.` })
        : null,
    ]));
  }

  blocks.push(el('div', { class: 'group' }, [
    el('div', { class: 'item-list' }, [
      el('button', {
        class: 'item', type: 'button',
        onclick: () => openSettings(bridge),
      }, [
        el('span', { class: 'item-main' }, [el('span', { class: 'item-title', text: 'Manage providers' })]),
        el('span', { class: 'item-chevron', text: '›' }),
      ]),
    ]),
  ]));

  return el('div', {}, blocks);
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
      app: 'nilgai-ui', version: 1, exportedAt: new Date().toISOString(),
      conversation: conv, messages: state.messages,
    });
  } else {
    const lines = [`# ${state.conv.title || 'Chat'}`, ''];
    for (const m of state.messages) {
      lines.push(`## ${m.role === 'user' ? 'You' : 'Assistant'}`, '', m.content || '', '');
    }
    downloadBlob(`${slug(state.conv.title)}.md`, new Blob([lines.join('\n')], { type: 'text/markdown' }));
  }
  closeSheet();
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

/* ── the bridge settings.js talks to ───────────────────────── */

const bridge = {
  getProviders: () => state.providers,
  saveProviders,
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
  $('#btnSettings').addEventListener('click', () => { closeDrawer(); openSettings(bridge); });
  dom.chip.addEventListener('click', openModelPicker);
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
    dom.jump.hidden = state.pinned || !state.messages.length;
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
    text: `NilgAI UI failed to start: ${err.message}`,
  }));
});
