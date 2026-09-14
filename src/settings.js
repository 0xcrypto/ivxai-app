// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* Settings, as a stack of screens on the bottom sheet.

   Each screen shows one group of related things; anything deeper is a row you
   tap. Fields save on change — there is no Save button to forget. */

import * as store from './store.js';
import * as vault from './vault.js';
import * as api from './providers.js';
import * as bridge from './bridge.js';
import {
  el, toast, openSheet, pushScreen, popScreen, closeSheet, refreshSheet,
  confirmAction, promptText, chooseFromList, askScreen, downloadJSON, searchBar,
} from './ui.js';

let app;                                   // the chat shell's own API

export function openSettings(shell) {
  app = shell;
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

/* ── first run ─────────────────────────────────────────────── */

export function openIntro(shell) {
  if (shell) app = shell;
  openSheet({ title: 'Welcome to NilgAI UI ✨', render: introScreen });
}

function introScreen() {
  const point = (title, body) => el('div', { class: 'intro-point' }, [
    el('div', { class: 'intro-title', text: title }),
    el('p', { class: 'intro-body', text: body }),
  ]);

  return el('div', {}, [
    el('div', { class: 'intro' }, [
      point('A UI for your LLM API',
        'Bring a key from any provider, or point it at a model running on your ' +
        'own machine. This is the interface — you choose the engine.'),
      point('Private and local first',
        'Ollama, LM Studio, llama.cpp and friends are first-class here, and a scan ' +
        'finds the ones already running. Hosted providers work too; the choice and ' +
        'the key stay yours.'),
      point('Lightweight, and it runs anywhere',
        'One page in a browser. No backend, no account, no telemetry. Your chats ' +
        'and keys are stored here and shipped nowhere.'),
    ]),
    el('div', { class: 'sheet-actions' }, [
      el('button', {
        class: 'btn btn-primary btn-block', type: 'button', text: 'Get started',
        onclick: () => closeSheet(),
      }),
      el('button', {
        class: 'btn btn-secondary btn-block', type: 'button', text: 'Set up a provider',
        onclick: () => { openSettings(app); pushScreen({ title: 'Providers', render: providersScreen }); },
      }),
    ]),
  ]);
}

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
      navRow('Connection', {
        sub: bridge.describe(),
        dot: bridge.ready(),
        onclick: () => pushScreen({ title: 'Connection', render: connectionScreen }),
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
    ], bridge.ready()
      ? 'Probed through the bridge, so a runtime that refuses browser origins still shows up.'
      : 'A runtime that refuses browser origins will not answer. Settings → Connection fixes that.'),

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
        onclick: async () => { await fetchModels(provider); refreshSheet(); },
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

/** Returns true when the list came back; false is a normal outcome here. */
async function fetchModels(provider) {
  const busy = toast(`Asking ${provider.name}…`, '', 20000);
  try {
    provider.models = await api.listModels(provider, vault.getKey(provider.id));
    if (!provider.defaultModel && provider.models.length) provider.defaultModel = provider.models[0];
    await app.saveProviders();
    app.refreshChrome();
    busy.remove();
    toast(provider.models.length
      ? `${provider.models.length} models available`
      : 'That endpoint listed no models — type the name instead', provider.models.length ? 'ok' : 'err');
    return provider.models.length > 0;
  } catch (err) {
    busy.remove();
    toast(`${err.message} — you can still type the model name`, 'err', 9000);
    return false;
  }
}

/**
 * Pick a model for a provider. Manual entry is always offered: plenty of
 * endpoints have no /models route at all (Azure deployments, bare llama.cpp
 * builds, private proxies) or refuse to list one without a key.
 */
export function chooseModel(provider, selected, title = 'Model') {
  return askScreen(title, done => {
    const models = api.knownModels(provider);

    const typeItIn = async () => {
      const name = await promptText({
        title: 'Model name',
        value: selected || '',
        placeholder: provider.kind === 'ollama' ? 'llama3.2' : 'gpt-4o-mini',
        okText: 'Use this model',
      });
      if (!name) return;
      api.rememberModel(provider, name);
      await app.saveProviders();
      done(name);
    };

    const content = el('div', {}, [
      models.length ? el('div', { class: 'group', dataset: { searchGroup: '' } }, [
        el('div', { class: 'item-list' }, models.map(m => el('button', {
          class: `item${m === selected ? ' is-active' : ''}`, type: 'button',
          dataset: { search: m.toLowerCase() },
          onclick: () => done(m),
        }, [
          el('span', { class: 'item-main' }, [el('span', { class: 'item-title', text: m })]),
          el('span', { class: 'item-check', text: m === selected ? '✓' : '' }),
        ]))),
      ]) : null,

      group(null, [
        actionRow('Type a model name', { onclick: typeItIn }),
        actionRow(models.length ? 'Refresh the list' : 'Fetch the model list', {
          sub: provider.baseUrl || 'No address set',
          onclick: async () => { await fetchModels(provider); refreshSheet(); },
        }),
      ], models.length ? null : 'No list yet. Fetch it, or just type the name — ' +
        'some endpoints do not publish one.'),
    ]);

    return el('div', {}, [searchBar(content, { placeholder: 'Search models' }), content]);
  });
}

async function pickModelFor(provider) {
  const model = await chooseModel(provider, provider.defaultModel, 'Default model');
  if (!model) return;
  provider.defaultModel = model;
  await app.saveProviders();
  app.refreshChrome();
  refreshSheet();
}

/* ── connection ────────────────────────────────────────────── */

const BRIDGE_HELP = 'https://github.com/0xcrypto/nilgai-app#the-bridge';

/**
 * The CORS bridge.
 *
 * Framed as a connection setting rather than a provider one because it is not
 * about any single endpoint: it changes how every provider call leaves this
 * page. The screen therefore has to be honest about that, and about the fact
 * that turning it on means trusting a second program on this machine.
 */
function connectionScreen() {
  const s = bridge.status();

  if (s.builtIn) {
    return el('div', {}, [
      group('CORS bridge', [
        actionRow('Built into this app', {
          sub: s.reachable ? `Running on ${s.url}` : 'Not answering — restart the app',
        }),
      ], 'The desktop and mobile app carries its own bridge, so every provider ' +
         'is reachable and there is nothing to set up.'),
    ]);
  }

  const toggle = async on => {
    if (!on) {
      await bridge.disable();
      refreshSheet();
      return;
    }
    try {
      await bridge.enable({ url: s.url || bridge.DEFAULT_URL, token: s.token });
      toast('Bridge on', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
    refreshSheet();
  };

  const rows = [
    switchRow('Use the bridge', s.enabled, toggle),
    navRow('Address', {
      value: s.url || bridge.DEFAULT_URL,
      onclick: async () => {
        const next = await promptText({
          title: 'Bridge address',
          value: s.url || bridge.DEFAULT_URL,
          placeholder: bridge.DEFAULT_URL,
        });
        if (next === null) return;
        const after = await bridge.configure({ url: next.trim() });
        if (after.enabled && !after.ready) toast('Saved, but nothing answered there', 'err');
        refreshSheet();
      },
    }),
    navRow('Token', {
      value: s.token ? 'Set' : 'None',
      sub: 'Only if the bridge was started with --token',
      onclick: async () => {
        const next = await promptText({
          title: 'Bridge token',
          value: s.token,
          placeholder: 'Leave empty for none',
        });
        if (next === null) return;
        await bridge.configure({ token: next.trim() });
        refreshSheet();
      },
    }),
    actionRow('Look for the bridge', {
      sub: 'Checks the usual address on this machine',
      onclick: lookForBridge,
    }),
    s.enabled ? actionRow('Check again', { onclick: recheckBridge }) : null,
  ];

  return el('div', {}, [
    group('CORS bridge', rows, statusNote(s)),

    group('What this is', [
      actionRow('Why you might need it', {
        sub: 'Ollama, llama.cpp and anything else that refuses browser origins',
        onclick: () => pushScreen({ title: 'About the bridge', render: bridgeAboutScreen }),
      }),
      linkRow('Get the bridge', BRIDGE_HELP, 'One small binary, or the full app'),
    ]),
  ]);
}

/** The line under the switch: what is true right now, and what to do about it. */
function statusNote(s) {
  if (!s.enabled) {
    return 'Off. Provider calls go straight from this page, which only works ' +
      'for endpoints that allow browser origins.';
  }
  if (!s.reachable) {
    return `Nothing answered at ${s.url}. Start it with \`nilgai-bridge\`, or ` +
      'turn this off to go direct again.';
  }
  if (!s.health.originAllowed) {
    return `The bridge is running but does not accept ${location.origin}. ` +
      `Restart it with --allow-origin ${location.origin}.`;
  }
  if (s.outdated) {
    return `The bridge speaks protocol ${s.health.protocol} and this app speaks ` +
      `${bridge.PROTOCOL}. Update whichever is older.`;
  }
  return `On. Provider calls go via ${s.url}, which is on this machine. ` +
    `Bridge ${s.health.version}.`;
}

async function lookForBridge() {
  const busy = toast('Looking on this machine…', '', 8000);
  const hit = await bridge.detect();
  busy.remove();

  if (!hit) {
    toast('No bridge answered. Is it running?', 'err');
    refreshSheet();
    return;
  }
  if (!hit.health.originAllowed) {
    toast(`Found a bridge at ${hit.url}, but it refuses ${location.origin}`, 'err');
    refreshSheet();
    return;
  }
  try {
    await bridge.enable({ url: hit.url });
    toast(`Bridge found at ${hit.url}`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
  refreshSheet();
}

async function recheckBridge() {
  const s = await bridge.verify();
  toast(s.ready ? 'Bridge is answering' : 'Bridge did not answer', s.ready ? 'ok' : 'err');
  refreshSheet();
}

function bridgeAboutScreen() {
  const point = (title, body) => el('div', { class: 'intro-point' }, [
    el('div', { class: 'intro-title', text: title }),
    el('p', { class: 'intro-body', text: body }),
  ]);

  return el('div', {}, [
    el('div', { class: 'intro' }, [
      point('A browser rule, not an endpoint problem',
        'A page may only call a server that says it accepts pages. Ollama does ' +
        'not by default, and neither do plenty of local runtimes and private ' +
        'proxies. They are running fine — the browser simply will not let this ' +
        'page speak to them.'),
      point('The bridge is a program on your machine',
        'It listens on loopback and forwards the call for you, then streams the ' +
        'answer back. It never stores anything, and your key goes to the same ' +
        'endpoint it would have gone to anyway.'),
      point('It only answers pages you allow',
        'By default that is this app and anything on localhost. A browser sets ' +
        'the origin itself and a page cannot fake it, so a site you happen to ' +
        'visit cannot borrow the bridge to reach your network.'),
      point('Or install the app instead',
        'The desktop and mobile builds carry the same bridge inside them, so ' +
        'there is nothing to run and nothing to switch on.'),
    ]),
    el('div', { class: 'sheet-actions' }, [
      el('a', {
        class: 'btn btn-secondary btn-block', href: BRIDGE_HELP,
        target: '_blank', rel: 'noopener noreferrer', text: 'How to get it',
      }),
    ]),
  ]);
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
    group(null, [
      actionRow('What is NilgAI UI?', { sub: 'The welcome tour', onclick: () => openIntro() }),
    ]),

    // Free software: the people running it should be able to find the source
    // and the terms without leaving the app.
    group('This app', [
      linkRow('Source code', 'https://github.com/0xcrypto/nilgai', 'github.com/0xcrypto/nilgai'),
      linkRow('Licence', 'https://www.gnu.org/licenses/gpl-3.0.html', 'GNU GPL v3 or later'),
    ], 'Free software: you may use, study, share and change it, provided your ' +
       'changes carry the same licence.'),

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
