// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* The Store: search and install providers, agents, MCP servers and skills from
   a catalog maintained in its own git repository (the ai-store repo).

   The catalog is data, not code. Every entry is a reviewable JSON file that
   arrives by pull request, and installing copies a known configuration into
   this browser — nothing in a catalog entry is ever executed. Keys are not
   part of the deal either: a provider entry carries an address and a pointer
   to where you get your own key, and the key stays in the vault.

   The catalog is fetched only while this screen is open, then cached in
   IndexedDB. A failed refresh falls back to the last good copy rather than
   emptying the store out from under the user. */

import * as store from './store.js';
import * as vault from './vault.js';
import {
  el, toast, openSheet, pushScreen, refreshSheet, confirmAction, promptText,
} from './ui.js';

/* Where the catalog lives — a directory URL ending before index.json, or an
   index.json path directly. Empty means the screen asks for an address on
   first use; set it once the ai-store repo is hosted. */
const DEFAULT_STORE_URL = '';

const URL_KEY = 'storeUrl';
const CACHE_KEY = 'storeCache';
const CACHE_MS = 24 * 60 * 60 * 1000;      // a day; the Refresh button forces a fetch

const KINDS = [
  { value: 'all', label: 'All' },
  { value: 'provider', label: 'Providers' },
  { value: 'agent', label: 'Agents' },
  { value: 'mcp', label: 'MCP' },
  { value: 'skill', label: 'Skills' },
  { value: 'installed', label: 'Installed' },
];
const KIND_LABEL = { provider: 'Provider', agent: 'Agent', mcp: 'MCP', skill: 'Skill' };

let app = null;            // the chat shell's API, wired by openMarket
let items = null;          // catalog entries; null while loading or unset
let source = '';           // the catalog address in use
let loadError = '';        // last fetch failure, '' when the catalog is healthy
let stale = false;         // true when showing a cache older than CACHE_MS
let loadPending = false;
let filter = 'all';
let query = '';
let addons = { mcp: [], skill: [] };       // installed MCP servers and skills

export function openMarket(shell) {
  app = shell;
  filter = 'all';
  query = '';
  // The very first open has nothing to show yet, so the loading note has to
  // be up before the first paint — load() only sets it after its first await.
  loadPending = items === null;
  openSheet({ title: 'Store', render: marketScreen });
  load(false).then(refreshSheet);
}

/* ── catalog loading ───────────────────────────────────────── */

async function load(force) {
  const url = String(await store.kvGet(URL_KEY, DEFAULT_STORE_URL) || '').trim();
  source = url;
  loadError = '';
  stale = false;
  addons = {
    mcp: await store.kvGet('mcpServers', []),
    skill: await store.kvGet('skills', []),
  };
  if (!url) { items = null; loadPending = false; return; }

  const cache = await store.kvGet(CACHE_KEY, null);
  if (!force && cache && cache.url === url && Array.isArray(cache.items) &&
      Date.now() - cache.fetchedAt < CACHE_MS) {
    items = cache.items;
    loadPending = false;
    return;
  }

  try {
    const indexUrl = /index\.json$/.test(url) ? url : url.replace(/\/+$/, '') + '/index.json';
    const res = await fetch(indexUrl);
    if (!res.ok) throw new Error(`index.json: HTTP ${res.status}`);
    const index = await res.json();
    const paths = Array.isArray(index?.items) ? index.items : [];
    const entries = await Promise.all(paths.map(async path => {
      const r = await fetch(new URL(path, indexUrl).href);
      if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
      return r.json();
    }));
    items = entries.filter(e => e && e.id && e.kind && e.name);
    await store.kvSet(CACHE_KEY, { url, fetchedAt: Date.now(), items });
  } catch (err) {
    loadError = err.message || String(err);
    // The last good copy keeps working; a broken network is not a deletion.
    if (cache && Array.isArray(cache.items) && cache.items.length) {
      items = cache.items;
      stale = true;
    } else {
      items = null;
    }
  }
  loadPending = false;
}

/* ── install / remove ──────────────────────────────────────── */

const sameUrl = u => String(u || '').replace(/\/+$/, '').toLowerCase();

async function installItem(item) {
  try {
    if (item.kind === 'provider') await installProvider(item);
    else if (item.kind === 'agent') await installAgent(item);
    else if (item.kind === 'mcp') await installMcp(item);
    else if (item.kind === 'skill') await installSkill(item);
    else throw new Error(`Unknown kind “${item.kind}”`);
  } catch (err) {
    toast(`Could not install ${item.name}: ${err.message || err}`, 'err', 8000);
  }
  refreshSheet();
}

/** Returns the created provider, or null when one was already configured. */
async function installProvider(item) {
  const config = item.config || {};
  const providers = app.getProviders();
  const dupe = providers.find(p => p.storeId === item.id) ||
    (config.baseUrl && providers.find(p => sameUrl(p.baseUrl) === sameUrl(config.baseUrl)));
  if (dupe) { toast('Already configured'); return null; }
  const provider = {
    id: store.uid(),
    storeId: item.id,
    name: config.name || item.name,
    kind: config.kind || 'openai',
    baseUrl: config.baseUrl || '',
    preset: null,
    models: Array.isArray(config.models) ? config.models.slice() : [],
    customModels: [],
    defaultModel: config.defaultModel || '',
    extraHeaders: config.extraHeaders && typeof config.extraHeaders === 'object'
      ? { ...config.extraHeaders } : {},
  };
  providers.push(provider);
  await app.saveProviders();
  // A provider is only usable through an agent, so it gets its default one.
  await app.attachDefaultAgent(provider);
  app.refreshChrome?.();
  toast(config.apiKeyUrl
    ? `${provider.name} added — paste your own key in Settings → Providers`
    : `${provider.name} added`, 'ok', 6000);
  return provider;
}

async function installAgent(item) {
  const config = item.config || {};
  const agents = app.getAgents();
  if (agents.some(a => a.storeId === item.id)) { toast('Already installed'); return; }

  // The agent needs a provider to speak. A matching configured one wins;
  // otherwise the entry's own provider spec is installed first.
  let providerId = null;
  const spec = config.provider && typeof config.provider === 'object' ? config.provider : null;
  if (spec) {
    const match = app.getProviders().find(p =>
      (spec.preset && p.preset === spec.preset) ||
      (spec.baseUrl && sameUrl(p.baseUrl) === sameUrl(spec.baseUrl)));
    providerId = match?.id ?? (await installProvider({
      id: `${item.id}·provider`, kind: 'provider',
      name: spec.name || `${item.name} provider`,
      config: {
        name: spec.name, kind: spec.kind, baseUrl: spec.baseUrl,
        models: spec.models, defaultModel: spec.defaultModel || config.model,
      },
    }))?.id ?? null;
  }

  agents.push({
    id: store.uid(),
    storeId: item.id,
    name: item.name,
    providerId,
    model: config.model || '',
    systemPrompt: config.systemPrompt || '',
    temperature: config.temperature ?? null,
    maxTokens: config.maxTokens ?? null,
    historyLimit: config.historyLimit ?? null,
    tools: config.tools !== false,
  });
  await app.saveAgents();
  app.refreshChrome?.();
  toast(`${item.name} added to agents`, 'ok');
}

async function installMcp(item) {
  const config = item.config || {};
  if (addons.mcp.some(m => m.storeId === item.id)) { toast('Already installed'); return; }
  addons.mcp.push({
    id: store.uid(), storeId: item.id, name: item.name,
    transport: config.transport || (config.url ? 'http' : 'stdio'),
    url: config.url || '', command: config.command || '',
    args: Array.isArray(config.args) ? config.args : [],
    env: config.env && typeof config.env === 'object' ? { ...config.env } : {},
    tools: Array.isArray(config.tools) ? config.tools : [],
    addedAt: Date.now(),
  });
  await store.kvSet('mcpServers', addons.mcp);
  toast(`${item.name} added — the app does not call MCP servers yet`, 'ok', 6000);
}

async function installSkill(item) {
  const config = item.config || {};
  if (addons.skill.some(s => s.storeId === item.id)) { toast('Already installed'); return; }
  addons.skill.push({
    id: store.uid(), storeId: item.id, name: item.name,
    instructions: config.instructions || '',
    addedAt: Date.now(),
  });
  await store.kvSet('skills', addons.skill);
  toast(`${item.name} added to skills`, 'ok');
}

async function removeItem(item) {
  const ok = await confirmAction({
    title: `Remove ${item.name}?`,
    body: item.kind === 'provider'
      ? 'Its API key is deleted too. Chats and agents that used it carry on with a snapshot.'
      : item.kind === 'agent'
        ? 'Chats that used it keep a snapshot of its settings.'
        : 'The entry is deleted from this browser.',
    okText: 'Remove',
  });
  if (!ok) return;
  try {
    if (item.kind === 'provider') {
      const provider = app.getProviders().find(p => p.storeId === item.id);
      if (provider) {
        const providers = app.getProviders();
        const i = providers.indexOf(provider);
        if (i >= 0) providers.splice(i, 1);
        await app.saveProviders();
        try { await vault.removeKey(provider.id); } catch { /* locked: stays encrypted */ }
        // Its agents would point at a provider that no longer exists.
        await app.forgetProvider(provider);
        app.refreshChrome?.();
      }
    } else if (item.kind === 'agent') {
      const agents = app.getAgents();
      const victim = agents.find(a => a.storeId === item.id);
      if (victim) {
        agents.splice(agents.indexOf(victim), 1);
        await app.saveAgents();
        app.refreshChrome?.();
      }
    } else if (item.kind === 'mcp') {
      addons.mcp = addons.mcp.filter(m => m.storeId !== item.id);
      await store.kvSet('mcpServers', addons.mcp);
    } else if (item.kind === 'skill') {
      addons.skill = addons.skill.filter(s => s.storeId !== item.id);
      await store.kvSet('skills', addons.skill);
    }
    toast(`${item.name} removed`, 'ok');
  } catch (err) {
    toast(err.message || String(err), 'err', 8000);
  }
  refreshSheet();
}

/* ── presence ──────────────────────────────────────────────── */

const isInstalled = item => {
  if (item.kind === 'provider') return app.getProviders().some(p => p.storeId === item.id);
  if (item.kind === 'agent') return app.getAgents().some(a => a.storeId === item.id);
  if (item.kind === 'mcp') return addons.mcp.some(m => m.storeId === item.id);
  if (item.kind === 'skill') return addons.skill.some(s => s.storeId === item.id);
  return false;
};

/* ── screens ───────────────────────────────────────────────── */

function marketScreen() {
  const search = el('input', {
    class: 'form-control market-search', type: 'search',
    placeholder: 'Search the store', value: query, autocomplete: 'off',
    onchange: ev => { query = ev.target.value; refreshSheet(); },
  });

  const body = el('div', {});
  paintBody(body);
  return el('div', {}, [
    el('div', { class: 'group' }, [
      sourceRow(), el('div', { class: 'item' }, [search]),
    ]),
    el('div', { class: 'market-chips' }, KINDS.map(k => el('button', {
      class: `market-chip${filter === k.value ? ' is-on' : ''}`,
      type: 'button', text: k.label,
      onclick: () => { filter = k.value; refreshSheet(); },
    }))),
    body,
  ]);
}

async function setSource() {
  const url = await promptText({
    title: 'Store address', value: source, okText: 'Set',
    placeholder: 'https://raw.githubusercontent.com/you/ai-store/main/',
  });
  if (url === null) return;
  await store.kvSet(URL_KEY, url);
  await load(true);
  refreshSheet();
}

function sourceRow() {
  return el('button', {
    class: 'item', type: 'button', onclick: setSource,
  }, [
    el('span', { class: 'item-main' }, [
      el('span', { class: 'item-title', text: 'Catalog address' }),
      el('span', {
        class: 'item-sub',
        text: source || 'Not set — point it at the hosted ai-store repo',
      }),
    ]),
    el('span', { class: 'item-chevron', text: '›' }),
  ]);
}

function paintBody(body) {
  clear(body);
  if (loadPending) {
    body.append(el('p', { class: 'group-note', text: 'Reading the catalog…' }));
    return;
  }
  if (!source) {
    body.append(el('div', { class: 'group' }, [
      el('div', { class: 'group-note', text: 'The store is a git-hosted catalog of providers, ' +
        'agents, MCP servers and skills. Entries are configuration, never code, and keys ' +
        'stay in this browser.' }),
      el('div', { class: 'sheet-actions' }, [
        el('button', {
          class: 'btn btn-primary btn-block', type: 'button', text: 'Set the store address',
          onclick: setSource,
        }),
      ]),
    ]));
    return;
  }
  if (loadError) {
    body.append(el('div', { class: 'group' }, [
      el('div', { class: 'group-note', text: `Could not read the catalog: ${loadError}` +
        (stale ? ' Showing the last good copy.' : '') }),
      el('div', { class: 'sheet-actions' }, [
        el('button', {
          class: 'btn btn-secondary btn-block', type: 'button', text: 'Try again',
          onclick: async () => { await load(true); refreshSheet(); },
        }),
      ]),
    ]));
    if (!items?.length) return;
  }

  const list = visibleItems();
  if (!list.length) {
    body.append(el('p', {
      class: 'group-note',
      text: filter === 'installed' ? 'Nothing installed yet.'
        : query ? 'Nothing matches.' : 'The catalog is empty.',
    }));
    return;
  }
  body.append(el('div', { class: 'group' }, list.map(itemRow)));
}

const visibleItems = () => {
  const q = query.trim().toLowerCase();
  const match = it => !q || [it.name, it.summary, it.description, ...(it.tags || [])]
    .some(t => String(t || '').toLowerCase().includes(q));
  let list = Array.isArray(items) ? items : [];
  if (filter === 'installed') list = list.filter(isInstalled);
  else if (filter !== 'all') list = list.filter(it => it.kind === filter);
  return list.filter(match).sort((a, b) => String(a.name).localeCompare(String(b.name)));
};

function itemRow(item) {
  const installed = isInstalled(item);
  // The row opens the entry's detail screen; the Install button stops
  // propagation so a tap on it never reads as "show me more".
  return el('div', {
    class: 'item is-link', role: 'button', tabindex: '0',
    onclick: () => pushScreen({ title: item.name, render: () => detailScreen(item) }),
  }, [
    el('span', { class: 'item-main' }, [
      el('span', { class: 'item-title market-title' }, [
        el('span', { text: item.name }),
        el('span', { class: 'tag', text: KIND_LABEL[item.kind] || item.kind }),
      ]),
      item.summary ? el('span', { class: 'item-sub', text: item.summary }) : null,
      el('span', { class: 'market-meta', text: meta(item) }),
    ]),
    installed
      ? el('button', {
          class: 'market-go is-done', type: 'button', text: 'Installed',
          onclick: ev => { ev.stopPropagation(); toast('Already installed'); },
        })
      : el('button', {
          class: 'market-go', type: 'button', text: 'Install',
          onclick: ev => { ev.stopPropagation(); installItem(item); },
        }),
  ]);
}

const meta = item => [item.author, item.version ? `v${item.version}` : '']
  .filter(Boolean).join(' · ');

function detailScreen(item) {
  const detail = (label, value) => el('div', { class: 'item' }, [
    el('span', { class: 'item-main' }, [
      el('span', { class: 'field-label', text: label }),
      el('span', { class: 'item-sub', text: value }),
    ]),
  ]);
  const config = item.config || {};
  const rows = [];
  if (item.kind === 'provider') {
    rows.push(detail('API style', config.kind || 'openai'));
    if (config.baseUrl) rows.push(detail('Address', config.baseUrl));
    if (config.defaultModel) rows.push(detail('Default model', config.defaultModel));
    if (config.apiKeyUrl) rows.push(detail('API key', `${config.apiKeyUrl} — you paste your own key; it stays in this browser`));
  } else if (item.kind === 'agent') {
    if (config.model) rows.push(detail('Model', config.model));
    const spec = config.provider || null;
    rows.push(detail('Provider', spec ? (spec.name || spec.preset || spec.baseUrl || 'installed on demand') : 'chosen after install'));
    rows.push(detail('Can ask other agents', config.tools === false ? 'no' : 'yes'));
    if (config.systemPrompt) rows.push(detail('System prompt', config.systemPrompt));
  } else if (item.kind === 'mcp') {
    rows.push(detail('Transport', config.transport || (config.url ? 'http' : 'stdio')));
    if (config.url) rows.push(detail('URL', config.url));
    if (config.command) rows.push(detail('Command', `${config.command} ${(config.args || []).join(' ')}`.trim()));
    if (config.tools?.length) rows.push(detail('Tools', config.tools.join(', ')));
  } else if (item.kind === 'skill') {
    if (config.instructions) rows.push(detail('Instructions', config.instructions));
  }

  return el('div', {}, [
    item.description || item.summary
      ? el('div', { class: 'group' }, [el('div', { class: 'group-note', text: item.description || item.summary })])
      : null,
    el('div', { class: 'group' }, [el('div', { class: 'item-list' }, rows)]),
    el('div', { class: 'group' }, [
      el('div', { class: 'item-list' }, [
        el('span', { class: 'item' }, [el('span', { class: 'item-main' }, [
          el('span', { class: 'item-title', text: meta(item) || '—' }),
          item.license ? el('span', { class: 'item-sub', text: `License: ${item.license}` }) : null,
        ])]),
        item.homepage ? el('a', {
          class: 'item', href: item.homepage, target: '_blank', rel: 'noopener noreferrer',
        }, [
          el('span', { class: 'item-main' }, [el('span', { class: 'item-title', text: 'Homepage' })]),
          el('span', { class: 'item-chevron', text: '›' }),
        ]) : null,
      ]),
    ]),
    el('div', { class: 'sheet-actions' }, [
      isInstalled(item)
        ? el('button', {
            class: 'btn btn-secondary btn-block', type: 'button', text: 'Remove from this browser',
            onclick: () => removeItem(item),
          })
        : el('button', {
            class: 'btn btn-primary btn-block', type: 'button', text: 'Install',
            onclick: () => installItem(item),
          }),
    ]),
  ]);
}