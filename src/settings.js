/* Settings, as a stack of screens on the bottom sheet.

   Each screen shows one group of related things; anything deeper is a row you
   tap. Fields save on change — there is no Save button to forget. */

import * as store from './store.js';
import * as vault from './vault.js';
import * as api from './providers.js';
import {
  el, toast, openSheet, pushScreen, popScreen, refreshSheet, confirmAction,
  promptText, chooseFromList, downloadJSON,
} from './ui.js';

let app;                                   // bridge back to the chat shell

export function openSettings(bridge) {
  app = bridge;
  openSheet({ title: 'Settings', render: rootScreen });
}

/* ── building blocks ───────────────────────────────────────── */

const group = (label, rows, note) => el('div', { class: 'group' }, [
  label ? el('div', { class: 'group-label', text: label }) : null,
  el('div', { class: 'item-list' }, rows.filter(Boolean)),
  note ? el('div', { class: 'group-note', text: note }) : null,
]);

const navRow = (title, { sub, value, onclick, tag, dot, danger } = {}) => el('button', {
  class: `item${danger ? ' danger' : ''}`, type: 'button', onclick,
}, [
  dot !== undefined ? el('span', { class: `dot${dot ? ' on' : ''}` }) : null,
  el('span', { class: 'item-main' }, [
    el('span', { class: 'item-title', text: title }),
    sub ? el('span', { class: 'item-sub', text: sub }) : null,
  ]),
  tag ? el('span', { class: 'tag', text: tag }) : null,
  value ? el('span', { class: 'item-value', text: value }) : null,
  el('span', { class: 'item-chevron', text: '›' }),
]);

const actionRow = (title, { onclick, danger, sub } = {}) => el('button', {
  class: `item${danger ? ' danger' : ''}`, type: 'button', onclick,
}, [
  el('span', { class: 'item-main' }, [
    el('span', { class: 'item-title', text: title }),
    sub ? el('span', { class: 'item-sub', text: sub }) : null,
  ]),
]);

const linkRow = (title, href, sub) => el('a', {
  class: 'item', href, target: '_blank', rel: 'noopener noreferrer',
}, [
  el('span', { class: 'item-main' }, [
    el('span', { class: 'item-title', text: title }),
    sub ? el('span', { class: 'item-sub', text: sub }) : null,
  ]),
  el('span', { class: 'item-chevron', text: '↗' }),
]);

const switchRow = (label, checked, onchange) => el('div', { class: 'item' }, [
  el('label', { class: 'form-check form-switch w-100' }, [
    el('span', { class: 'form-check-label', text: label }),
    el('input', { class: 'form-check-input', type: 'checkbox', checked, onchange: ev => onchange(ev.target.checked) }),
  ]),
]);

const field = (label, control, note) => el('div', { class: 'field' }, [
  el('label', { class: 'field-label', text: label }),
  control,
  note ? el('div', { class: 'field-note', text: note }) : null,
]);

/* ── root ──────────────────────────────────────────────────── */

function rootScreen() {
  const providers = app.getProviders();
  const local = providers.filter(p => api.isLocalUrl(p.baseUrl)).length;
  const { encrypted, unlocked } = vault.status();

  return el('div', {}, [
    group(null, [
      navRow('Providers', {
        sub: providers.length
          ? `${providers.length} configured · ${local} local`
          : 'None yet — add one to start',
        onclick: () => pushScreen({ title: 'Providers', render: providersScreen }),
      }),
      navRow('Appearance', {
        sub: `${app.getUI().theme} theme`,
        onclick: () => pushScreen({ title: 'Appearance', render: appearanceScreen }),
      }),
      navRow('Privacy & data', {
        sub: encrypted ? (unlocked ? 'Keys encrypted, unlocked' : 'Keys encrypted, locked') : 'Keys stored in the clear',
        onclick: () => pushScreen({ title: 'Privacy & data', render: privacyScreen }),
      }),
      navRow('About', { onclick: () => pushScreen({ title: 'About', render: aboutScreen }) }),
    ]),
  ]);
}

/* ── providers ─────────────────────────────────────────────── */

function providersScreen() {
  const providers = app.getProviders();

  return el('div', {}, [
    group('On this machine', [
      actionRow('Scan for local servers', {
        sub: 'Ollama, LM Studio, llama.cpp, Jan, vLLM…',
        onclick: scanLocal,
      }),
    ], 'Nothing you type reaches the network when you use a local model.'),

    group('Configured', providers.length
      ? providers.map(p => navRow(p.name, {
          sub: p.baseUrl || 'No address set',
          dot: Boolean(p.models?.length),
          tag: api.isLocalUrl(p.baseUrl) ? 'local' : null,
          onclick: () => pushScreen({ title: p.name, render: () => providerScreen(p) }),
        }))
      : [actionRow('No providers yet', {})]),

    group(null, [
      actionRow('Add a provider', { onclick: addProvider }),
    ]),
  ]);
}

async function scanLocal() {
  const busy = toast('Looking on the usual ports…', '', 20000);
  let hits = [];
  try {
    hits = await api.scanLocal();
  } catch (err) {
    busy.remove();
    toast(err.message, 'err');
    return;
  }
  busy.remove();

  if (!hits.length) {
    toast('Nothing answered. Either no local server is running, or it refuses browser origins.', 'err', 9000);
    return;
  }

  const providers = app.getProviders();
  let added = 0;
  for (const hit of hits) {
    const trim = u => u.replace(/\/+$/, '');
    const existing = providers.find(p => trim(p.baseUrl) === trim(hit.baseUrl));
    if (existing) {
      existing.models = hit.models;
      if (!existing.defaultModel && hit.models.length) existing.defaultModel = hit.models[0];
      continue;
    }
    const provider = api.makeProvider(hit.preset);
    provider.baseUrl = hit.baseUrl;
    provider.models = hit.models;
    provider.defaultModel = hit.models[0] || '';
    providers.push(provider);
    added++;
  }
  await app.saveProviders();
  refreshSheet();
  toast(added ? `Added ${added} local provider${added === 1 ? '' : 's'}` : 'Already configured — models refreshed', 'ok');
}

async function addProvider() {
  const items = [
    ...api.PRESETS.filter(p => p.local).map(p => ({ value: p.key, label: p.name, sub: p.baseUrl })),
    ...api.PRESETS.filter(p => !p.local).map(p => ({ value: p.key, label: p.name, sub: p.baseUrl || 'Custom address' })),
  ];
  const key = await chooseFromList({ title: 'Add a provider', items });
  if (!key) return;

  const preset = api.PRESETS.find(p => p.key === key);
  const provider = api.makeProvider(preset);
  const providers = app.getProviders();
  if (providers.some(p => p.name === provider.name)) provider.name = `${provider.name} 2`;
  providers.push(provider);
  await app.saveProviders();
  refreshSheet();
  pushScreen({ title: provider.name, render: () => providerScreen(provider) });
}

function providerScreen(provider) {
  const preset = api.PRESETS.find(p => p.key === provider.preset);
  const { encrypted, unlocked } = vault.status();
  const locked = encrypted && !unlocked;
  const kindLabel = api.KINDS.find(k => k.value === provider.kind)?.label || provider.kind;

  const save = async () => { await app.saveProviders(); app.refreshChrome(); };

  const nameInput = el('input', {
    class: 'form-control', type: 'text', value: provider.name, placeholder: 'Name',
    onchange: async ev => {
      provider.name = ev.target.value.trim() || 'Provider';
      await save();
      refreshSheet();
    },
  });

  const urlInput = el('input', {
    class: 'form-control', type: 'url', value: provider.baseUrl, placeholder: 'http://localhost:11434',
    spellcheck: 'false', autocapitalize: 'off',
    onchange: async ev => {
      provider.baseUrl = ev.target.value.trim();
      provider.models = [];
      await save();
      refreshSheet();
    },
  });

  const keyInput = el('input', {
    class: 'form-control', type: 'password', autocomplete: 'off',
    value: locked ? '' : vault.getKey(provider.id),
    placeholder: locked ? 'Locked' : (preset?.needsKey === false ? 'Not required' : 'Paste your key'),
    disabled: locked,
    onchange: async ev => {
      try {
        await vault.setKey(provider.id, ev.target.value.trim());
        toast('Key saved to this browser', 'ok');
      } catch (err) { toast(err.message, 'err'); }
    },
  });

  return el('div', {}, [
    group(null, [
      el('div', { class: 'item' }, [field('Name', nameInput)]),
      navRow('API style', {
        value: kindLabel,
        onclick: async () => {
          const kind = await chooseFromList({
            title: 'API style',
            items: api.KINDS.map(k => ({ value: k.value, label: k.label })),
            selected: provider.kind,
          });
          if (!kind) return;
          provider.kind = kind;
          provider.models = [];
          await save();
          refreshSheet();
        },
      }),
      el('div', { class: 'item' }, [field('Address', urlInput)]),
      el('div', { class: 'item' }, [field('API key', keyInput,
        locked ? 'Unlock under Privacy & data to edit.' : 'Stored in this browser only.')]),
    ]),

    group('Model', [
      navRow('Default model', {
        sub: provider.defaultModel || 'Not set',
        onclick: () => pickModelFor(provider),
      }),
      actionRow(provider.models?.length ? `Refresh models (${provider.models.length} cached)` : 'Fetch models', {
        onclick: () => fetchModels(provider),
      }),
    ], preset?.hint),

    group(null, [
      actionRow('Remove provider', {
        danger: true,
        onclick: async () => {
          const ok = await confirmAction({
            title: `Remove ${provider.name}?`,
            body: 'Its API key is deleted too. Chats that used it are kept.',
            okText: 'Remove',
          });
          if (!ok) return;
          const providers = app.getProviders();
          const i = providers.indexOf(provider);
          if (i >= 0) providers.splice(i, 1);
          try { await vault.removeKey(provider.id); } catch { /* locked: stays encrypted */ }
          await save();
          popScreen();
          refreshSheet();
        },
      }),
    ]),
  ]);
}

async function fetchModels(provider) {
  const busy = toast(`Asking ${provider.name}…`, '', 20000);
  try {
    provider.models = await api.listModels(provider, vault.getKey(provider.id));
    if (!provider.defaultModel && provider.models.length) provider.defaultModel = provider.models[0];
    await app.saveProviders();
    app.refreshChrome();
    busy.remove();
    toast(`${provider.models.length} models available`, 'ok');
    refreshSheet();
  } catch (err) {
    busy.remove();
    toast(err.message, 'err', 9000);
  }
}

async function pickModelFor(provider) {
  if (!provider.models?.length) {
    await fetchModels(provider);
    if (!provider.models?.length) return;
  }
  const model = await chooseFromList({
    title: 'Default model',
    items: provider.models.map(m => ({ value: m, label: m })),
    selected: provider.defaultModel,
  });
  if (!model) return;
  provider.defaultModel = model;
  await app.saveProviders();
  app.refreshChrome();
  refreshSheet();
}

/* ── appearance ────────────────────────────────────────────── */

function appearanceScreen() {
  const ui = app.getUI();
  const pick = async (title, key, items) => {
    const value = await chooseFromList({ title, items, selected: ui[key] });
    if (!value) return;
    app.setUI({ [key]: value });
    app.applyAppearance();
    refreshSheet();
  };

  return el('div', {}, [
    group(null, [
      navRow('Theme', {
        value: { auto: 'System', dark: 'Dark', light: 'Light' }[ui.theme],
        onclick: () => pick('Theme', 'theme', [
          { value: 'auto', label: 'Follow system' },
          { value: 'dark', label: 'Dark' },
          { value: 'light', label: 'Light' },
        ]),
      }),
      navRow('Text width', {
        value: { narrow: 'Narrow', default: 'Default', wide: 'Wide', full: 'Full' }[ui.width] || 'Default',
        onclick: () => pick('Text width', 'width', [
          { value: 'narrow', label: 'Narrow' },
          { value: 'default', label: 'Default' },
          { value: 'wide', label: 'Wide' },
          { value: 'full', label: 'Full width' },
        ]),
      }),
    ]),
    group(null, [
      switchRow('Enter sends the message', ui.sendOnEnter, v => app.setUI({ sendOnEnter: v })),
    ], 'With this off, Enter starts a new line and ⌘/Ctrl+Enter sends.'),
  ]);
}

/* ── privacy & data ────────────────────────────────────────── */

function privacyScreen() {
  const { encrypted, unlocked } = vault.status();

  return el('div', {}, [
    group('API keys', encrypted
      ? [
          actionRow(unlocked ? 'Keys are unlocked for this session' : 'Keys are locked', {
            sub: unlocked ? 'Tap to lock them again' : 'Tap to unlock',
            onclick: async () => {
              if (unlocked) { vault.lock(); app.refreshChrome(); refreshSheet(); toast('Keys locked'); }
              else { await app.askUnlock(); refreshSheet(); }
            },
          }),
          actionRow('Turn off encryption', { danger: true, onclick: disableEncryption }),
        ]
      : [actionRow('Encrypt keys with a passphrase', { onclick: enableEncryption })],
      encrypted
        ? 'AES-GCM with a PBKDF2-derived key. The key lives in memory only, so you unlock once per session.'
        : 'Keys currently sit in IndexedDB in the clear, readable by anyone who can use this browser unlocked.'),

    group('Backup', [
      actionRow('Export everything', { sub: 'Chats, providers and settings', onclick: () => exportAll(false) }),
      actionRow('Export including API keys', { sub: 'The file will contain your secrets', onclick: () => exportAll(true) }),
      actionRow('Import a backup', { onclick: importBackup }),
    ]),

    group('Danger zone', [
      actionRow('Delete all chats', { danger: true, onclick: deleteAllChats }),
      actionRow('Erase everything', { danger: true, sub: 'Chats, keys, settings and the offline cache', onclick: eraseAll }),
    ]),
  ]);
}

async function enableEncryption() {
  const pass = await promptText({ title: 'Choose a passphrase', placeholder: 'At least 8 characters' });
  if (pass === null) return;
  if (pass.length < 8) { toast('Use at least 8 characters', 'err'); return; }
  const again = await promptText({ title: 'Repeat it', placeholder: 'Same passphrase' });
  if (again === null) return;
  if (again !== pass) { toast('They do not match', 'err'); return; }
  await vault.enable(pass);
  app.refreshChrome();
  refreshSheet();
  toast('API keys encrypted', 'ok');
}

async function disableEncryption() {
  const ok = await confirmAction({
    title: 'Turn off encryption?',
    body: 'Your API keys will be stored unencrypted in this browser.',
    okText: 'Turn off',
  });
  if (!ok) return;
  try {
    await vault.disable();
    app.refreshChrome();
    refreshSheet();
    toast('Encryption off');
  } catch (err) { toast(err.message, 'err'); }
}

async function exportAll(withKeys) {
  const kv = (await store.kvAll()).filter(r => r.key !== 'secrets' && r.key !== 'vault');
  if (withKeys) {
    try {
      kv.push({ key: 'secrets', value: vault.exportSecrets() });
    } catch (err) { toast(err.message, 'err'); return; }
  }
  downloadJSON(`nilgai-ui-backup-${new Date().toISOString().slice(0, 10)}.json`, {
    app: 'nilgai-ui', version: 1, exportedAt: new Date().toISOString(),
    containsKeys: withKeys,
    conversations: await store.listConversations(),
    messages: await store.allMessages(),
    kv,
  });
  toast(withKeys ? 'Exported — this file contains your API keys' : 'Exported', 'ok', 7000);
}

function importBackup() {
  const picker = el('input', { type: 'file', accept: 'application/json,.json' });
  picker.addEventListener('change', async () => {
    const file = picker.files?.[0];
    if (!file) return;
    let bundle;
    try {
      bundle = JSON.parse(await file.text());
    } catch {
      toast('That file is not valid JSON', 'err');
      return;
    }
    const single = bundle.conversation && Array.isArray(bundle.messages);
    const conversations = single ? [bundle.conversation] : (bundle.conversations || []);
    const messages = bundle.messages || [];
    if (!conversations.length && !messages.length && !bundle.kv) {
      toast('Nothing recognisable in that file', 'err');
      return;
    }
    const ok = await confirmAction({
      title: 'Import this backup?',
      body: `${conversations.length} chats and ${messages.length} messages will be merged in.` +
        (bundle.containsKeys ? ' It also contains API keys.' : ''),
      okText: 'Import',
      danger: false,
    });
    if (!ok) return;

    const secrets = (bundle.kv || []).find(r => r.key === 'secrets')?.value;
    const kv = (bundle.kv || []).filter(r => r.key !== 'secrets' && r.key !== 'vault');
    await store.importBundle({ conversations, messages, kv });
    if (secrets && typeof secrets === 'object') {
      try { await vault.importSecrets(secrets); } catch (err) { toast(err.message, 'err'); }
    }
    await app.reloadData();
    refreshSheet();
    toast('Import complete', 'ok');
  });
  picker.click();
}

async function deleteAllChats() {
  const ok = await confirmAction({
    title: 'Delete all chats?',
    body: 'Providers and keys are kept. Every conversation is removed.',
    okText: 'Delete all',
  });
  if (!ok) return;
  await app.deleteAllChats();
  toast('All chats deleted');
}

async function eraseAll() {
  const ok = await confirmAction({
    title: 'Erase everything?',
    body: 'Chats, providers, API keys, preferences and the offline cache. This cannot be undone.',
    okText: 'Erase',
  });
  if (!ok) return;
  await store.wipeEverything();
  location.reload();
}

/* ── about ─────────────────────────────────────────────────── */

/* __VERSIONS__ is stamped in by vite.config.js from what is actually installed. */
const version = (key, licence) => {
  const v = (typeof __VERSIONS__ === 'object' && __VERSIONS__[key]) || '';
  return v ? `v${v} · ${licence}` : licence;
};

function aboutScreen() {
  const para = text => el('p', { class: 'group-note', text });
  return el('div', {}, [
    group('Created by @0xcrypto', [
      linkRow('X', 'https://x.com/0xcrypto', 'x.com/0xcrypto'),
      linkRow('LinkedIn', 'https://linkedin.com/in/0xcrypto', 'linkedin.com/in/0xcrypto'),
      linkRow('GitHub', 'https://github.com/0xcrypto', 'github.com/0xcrypto'),
      linkRow('Blog', 'https://eval.blog', 'eval.blog'),
    ]),
    el('div', { class: 'group' }, [
      para('A chat client that runs entirely in your browser. No backend, no accounts, ' +
           'no analytics, and no third-party scripts or fonts at runtime — everything it ' +
           'loads comes from this origin.'),
      para('The only network requests it makes are the ones you ask for: chat completions ' +
           'and model lists, sent straight to the endpoint you configured.'),
    ]),
    group('Where your data lives', [
      actionRow('IndexedDB · nilgai', { sub: 'Conversations, messages, providers, API keys' }),
      actionRow('localStorage · nilgai.ui', { sub: 'Theme and layout preferences' }),
      actionRow('Cache Storage', { sub: 'The app shell, so it runs offline' }),
    ]),
    el('div', { class: 'group' }, [
      para('Browsers require the provider to allow cross-origin calls. OpenRouter, OpenAI ' +
           'and Anthropic do. For Ollama, start it with OLLAMA_ORIGINS set to this app’s origin.'),
    ]),

    group('Built with', [
      linkRow('Vite', 'https://vite.dev', version('vite', 'MIT')),
      linkRow('Halfmoon CSS', 'https://www.gethalfmoon.com', version('halfmoon', 'MIT')),
      // The installed version is @fontsource's packaging, not IBM's own release.
      linkRow('IBM Plex', 'https://www.ibm.com/plex/', 'SIL OFL · via @fontsource'),
    ], 'All three are bundled into the build and served from this origin — none of ' +
       'them is fetched from a CDN at runtime.'),
  ]);
}
