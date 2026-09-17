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
import * as registry from './registry.js';
import * as usage from './usage.js';
import {
  el, clear, toast, openSheet, pushScreen, refreshSheet, confirmAction, promptText,
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
let addons = { skill: [] };                // installed skills; MCP servers are asked of the app

/* The MCP registry is a second source, off until it is asked for: it is a
   third party, and turning it on is what starts talking to it. */
let registryOn = false;
let registryUrl = registry.DEFAULT_URL;
let registryItems = [];
let registryError = '';
let registryPending = false;

/** Read once at boot so Settings can show the address without awaiting. */
export async function initStore() {
  source = String(await store.kvGet(URL_KEY, DEFAULT_STORE_URL) || '').trim();
  return source;
}

/** The catalog address. Settings owns the screen for it; this owns the value. */
export const catalogUrl = () => source;

export async function setCatalogUrl(next) {
  source = String(next || '').trim();
  await store.kvSet(URL_KEY, source);
}

export function openMarket(shell) {
  app = shell;
  filter = 'all';
  query = '';
  // The very first open has nothing to show yet, so the loading note has to
  // be up before the first paint — load() only sets it after its first await.
  loadPending = items === null;
  // A place you go, not a tray over the chat: the Store is a page.
  openSheet({ title: 'Store', render: marketScreen, page: true });
  load(false).then(refreshSheet);
}

/* ── catalog loading ───────────────────────────────────────── */

async function load(force) {
  const url = String(await store.kvGet(URL_KEY, DEFAULT_STORE_URL) || '').trim();
  source = url;
  loadError = '';
  stale = false;
  addons = { skill: await store.kvGet('skills', []) };
  registryOn = registry.isOn();
  registryUrl = registry.url();
  if (!registryOn) { registryItems = []; registryError = ''; }
  if (!url) { items = null; loadPending = false; if (registryOn) await loadRegistry(); return; }

  if (registryOn) await loadRegistry();

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

/** Ask the registry for what matches the current search. Its failures are
    kept apart from the catalog's: one source being down is not the other
    source being empty. */
async function loadRegistry() {
  if (!registryOn) { registryItems = []; return; }
  registryPending = true;
  try {
    registryItems = await registry.search(query);
    registryError = '';
  } catch (err) {
    registryItems = [];
    registryError = err.message || String(err);
  } finally {
    registryPending = false;
  }
  // Counted after the list is in hand, and awaited: an entry that arrives
  // without its number and grows one a second later is harder to read than one
  // that arrives complete.
  try { await usage.fetchDownloads(registryItems); } catch { /* numbers are optional */ }
}

/** Where the Store's sources are configured: in Settings, with everything
    else that decides what this app talks to. Pushed onto this sheet, so Back
    comes straight back to the Store, and what changed is reloaded on the way. */
function openSources() {
  app.openStoreSettings?.(() => { load(true).then(refreshSheet); });
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

/** stdio or not: everything else — `http`, `sse`, nothing at all — is a
    remote server as far as this app is concerned. */
const mcpTransport = config =>
  (config.transport === 'stdio' || (!config.url && config.command) ? 'stdio' : 'http');

const hostOf = url => { try { return new URL(url).host; } catch { return String(url || 'that server'); } };

/**
 * What installing an MCP server actually costs, in the words of the thing it
 * costs it in.
 *
 * The rest of the store installs settings: an address, a prompt, a model
 * name. An MCP server installs reach — either a program that runs here with
 * everything your account can touch, or a stranger who gets sent whatever the
 * model decides to pass as arguments. That is not a detail for the detail
 * screen; it is the decision, so it is put in front of the person before the
 * install and again on the entry itself.
 */
function mcpWarning(item, config = item.config || {}) {
  if (mcpTransport(config) === 'stdio') {
    const line = `${config.command || ''} ${(config.args || []).join(' ')}`.trim();
    return `This runs a program on this machine${line ? ` — ${line}` : ''}, started by the ` +
      'bridge with your user\u2019s rights: it can read and change whatever you can. The ' +
      'catalog only describes it. Install it if you trust the program itself.';
  }
  return `Its tools run on ${hostOf(config.url)} \u2014 a third party, not this machine and ` +
    'not ivx/ai. Calling one sends the arguments the model chose, which can include what ' +
    'you wrote in the chat, to that server, and its answer comes back into the ' +
    'conversation. Nothing else in this browser is shared.';
}

/** The name the model writes in a tool call, so it cannot carry a space or the
    slash that separates server from tool. */
function serverName(wanted, servers) {
  const base = String(wanted || 'mcp-server').replace(/[\s/\\]+/g, '-').replace(/^-+|-+$/g, '') || 'mcp-server';
  const taken = new Set(servers.map(s => s.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

async function installMcp(item) {
  const config = item.config || {};
  if (isInstalled(item)) { toast('Already installed'); return; }
  const transport = mcpTransport(config);
  const ok = await confirmAction({
    title: transport === 'stdio'
      ? `Run ${item.name} on this machine?`
      : `Send tool calls to ${hostOf(config.url)}?`,
    body: mcpWarning(item, config),
    okText: 'Install',
    // A program that runs here is the one that cannot be undone by deleting a
    // row later; a remote server is a choice, not an alarm.
    danger: transport === 'stdio',
  });
  if (!ok) return;
  const servers = app.getMcpServers();
  servers.push({
    id: store.uid(), storeId: item.id, name: serverName(item.name, servers),
    transport,
    url: config.url || '', command: config.command || '',
    args: Array.isArray(config.args) ? config.args : [],
    env: config.env && typeof config.env === 'object' ? { ...config.env } : {},
    token: config.token || '',
    headers: config.headers && typeof config.headers === 'object' ? { ...config.headers } : {},
    // A local server has no other way to run; a remote one only rides the
    // bridge when the entry says so.
    viaBridge: transport === 'stdio' ? true : Boolean(config.viaBridge),
    tools: Array.isArray(config.tools) ? config.tools : [],
    enabled: true,
    addedAt: Date.now(),
  });
  await app.saveMcpServers(servers);
  toast(`${item.name} added — its tools are offered to agents with tools on`, 'ok', 6000);
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
      await app.saveMcpServers(app.getMcpServers().filter(m => m.storeId !== item.id));
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
  // Asked of the app rather than of the copy this screen loaded, so a server
  // installed a second ago already reads as installed.
  if (item.kind === 'mcp') return app.getMcpServers().some(m => m.storeId === item.id);
  if (item.kind === 'skill') return addons.skill.some(s => s.storeId === item.id);
  return false;
};

/* ── screens ───────────────────────────────────────────────── */

function marketScreen() {
  const search = el('input', {
    class: 'form-control market-search', type: 'search',
    placeholder: 'Search the store', value: query, autocomplete: 'off',
    onchange: async ev => {
      query = ev.target.value;
      refreshSheet();
      // The catalog is in memory and filters itself; the registry is an index
      // of thousands and does the searching at its end.
      if (registryOn) { await loadRegistry(); refreshSheet(); }
    },
  });

  const body = el('div', {});
  paintBody(body);
  return el('div', {}, [
    // Search and the filters travel together and stay put while the list
    // scrolls: on a page this long, the way to narrow it should not be
    // somewhere above you.
    el('div', { class: 'sheet-search market-head' }, [
      search,
      el('div', { class: 'market-chips' }, KINDS.map(k => el('button', {
        class: `market-chip${filter === k.value ? ' is-on' : ''}`,
        type: 'button', text: k.label,
        onclick: () => { filter = k.value; refreshSheet(); },
      }))),
    ]),
    body,
    // Where these entries came from, and the way to change it: one quiet line
    // at the end of the list rather than another card competing with them.
    // What the sources mean, and the warning that goes with the registry, is
    // Settings' business — this only names them.
    registryOn || source
      ? el('p', { class: 'group-note market-sources' }, [
          el('button', {
            class: 'status-link', type: 'button', text: sourcesLine(), onclick: openSources,
          }),
        ])
      : null,
  ]);
}

/** Which sources answered, in the space of one line. */
function sourcesLine() {
  const bits = [];
  if (registryOn) bits.push(registry.host(registryUrl));
  if (source) bits.push(registry.host(source) || source);
  return `From ${bits.join(' and ')}`;
}

function paintBody(body) {
  clear(body);
  if (loadPending) {
    body.append(el('p', { class: 'group-note', text: 'Reading the catalog…' }));
    return;
  }
  if (!source && !registryOn) {
    // Neither source is on, so there is nothing to search and the only useful
    // thing on this screen is the way to turn one on. No early return, though:
    // something installed earlier is still installed, and the Installed filter
    // has to show it whichever sources are switched off today.
    body.append(el('div', { class: 'group' }, [
      el('div', { class: 'group-note', text: 'The Store draws on two sources: a git-hosted ' +
        'catalog of providers, agents and skills, and the MCP registry for MCP servers. ' +
        'Neither is switched on. Entries are configuration, never code, and keys stay in ' +
        'this browser.' }),
      el('div', { class: 'sheet-actions' }, [
        el('button', {
          class: 'btn btn-primary btn-block', type: 'button', text: 'Choose the sources',
          onclick: openSources,
        }),
      ]),
    ]));
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

  if (registryError) {
    body.append(el('div', { class: 'group' }, [
      el('div', { class: 'group-note', text: `Could not read the MCP registry: ${registryError}` }),
      el('div', { class: 'sheet-actions' }, [
        el('button', {
          class: 'btn btn-secondary btn-block', type: 'button', text: 'Try the registry again',
          onclick: async () => { await loadRegistry(); refreshSheet(); },
        }),
      ]),
    ]));
  }

  const list = visibleItems();
  if (registryPending && !list.length) {
    body.append(el('p', { class: 'group-note', text: 'Searching the MCP registry\u2026' }));
    return;
  }
  if (!list.length) {
    // With no catalog address and no registry, the card above already says
    // what to do about it; a second line saying "empty" adds nothing.
    if (source || registryOn || filter === 'installed') {
      body.append(el('p', {
        class: 'group-note',
        text: filter === 'installed' ? 'Nothing installed yet.'
          : query ? 'Nothing matches.'
            : registryOn ? 'Nothing to show yet.' : 'The catalog is empty.',
      }));
    }
    return;
  }
  body.append(el('div', { class: 'group' }, list.map(itemRow)));
}

const visibleItems = () => {
  const q = query.trim().toLowerCase();
  const match = it => !q || [it.name, it.summary, it.description, ...(it.tags || [])]
    .some(t => String(t || '').toLowerCase().includes(q));
  // The catalog is searched here; the registry answered the same question at
  // its end, so its results are taken as they came.
  const catalog = (Array.isArray(items) ? items : []).filter(match);
  const list = [...catalog, ...registryItems];
  const kept = filter === 'installed'
    ? [...list.filter(isInstalled), ...installedElsewhere(list)]
    : filter === 'all' ? list : list.filter(it => it.kind === filter);
  return kept.sort((a, b) => String(a.name).localeCompare(String(b.name)));
};

/** MCP servers installed from a source that is not in front of us right now —
    a registry search that has moved on, or a catalog that is switched off.
    Installed means installed; the list should not depend on what is on screen.
    They are described from what was saved, which is all there is to say. */
function installedElsewhere(shown) {
  const seen = new Set(shown.map(it => it.id));
  return app.getMcpServers()
    .filter(s => s.storeId && !seen.has(s.storeId))
    .map(s => ({
      id: s.storeId,
      kind: 'mcp',
      registry: String(s.storeId).startsWith('mcp:'),
      name: s.name,
      summary: s.transport === 'stdio'
        ? `${s.command} ${(s.args || []).join(' ')}`.trim()
        : s.url,
      description: '',
      author: '',
      version: '',
      tags: [],
      config: {
        transport: s.transport, url: s.url, command: s.command,
        args: s.args, env: s.env, headers: s.headers,
      },
    }));
}

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
        // One tag, for the one thing worth knowing before opening a row: where
        // an MCP server runs. The kind matters only when kinds are mixed, and
        // which source it came from is answered once, at the foot of the list.
        item.kind === 'mcp'
          ? el('span', { class: 'tag', text: mcpTransport(item.config || {}) === 'stdio' ? 'local' : 'remote' })
          : el('span', { class: 'tag', text: KIND_LABEL[item.kind] || item.kind }),
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

const meta = item => [item.author, item.version ? `v${item.version}` : '', weekly(item)]
  .filter(Boolean).join(' \u00b7 ');

/** How many people ran this last week, when that is knowable. The registry
    has no ratings to show; this is the nearest honest thing. */
function weekly(item) {
  const count = item.npmPackage ? usage.downloads(item.npmPackage) : undefined;
  return typeof count === 'number' ? `${usage.compact(count)} installs/week` : '';
}

/** The npm package and what it is worth knowing about it. */
function packageLine(item) {
  const count = usage.downloads(item.npmPackage);
  if (typeof count === 'number') {
    return `${item.npmPackage} \u2014 ${usage.compact(count)} installs a week from npm`;
  }
  return item.npmPackage;
}

/** The repository, with GitHub's own numbers when they could be had. */
function repoLine(item) {
  const facts = usage.repo(item.repository);
  if (facts === undefined) return `${item.repository}${usage.isOn() ? ' \u2014 checking\u2026' : ''}`;
  if (!facts) return item.repository;
  const bits = [`${usage.compact(facts.stars)} stars`];
  if (facts.pushed) bits.push(`last commit ${usage.ago(facts.pushed)}`);
  if (facts.archived) bits.push('archived');
  return `${item.repository} \u2014 ${bits.join(', ')}`;
}

function detailScreen(item) {
  // GitHub allows a browser sixty questions an hour, so it is asked about one
  // repository at a time — the one being read right now — and the answer, or
  // its absence, is remembered for the session.
  if (usage.isOn() && item.repository && usage.repo(item.repository) === undefined) {
    usage.fetchRepo(item.repository).then(() => refreshSheet());
  }
  // Facts wrap rather than trail off: a command line, a repository URL or what
  // a namespace proves is worth nothing cut short with an ellipsis.
  const detail = (label, value) => el('div', { class: 'item' }, [
    el('span', { class: 'item-main' }, [
      el('span', { class: 'field-label', text: label }),
      el('span', { class: 'item-sub detail-value', text: value }),
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
    // Who, before what: a name in the registry is a claim, and this is the
    // part of it that was checked.
    if (item.publisher) {
      rows.push(detail('Published by', `${item.publisher.label} — the registry made them prove ` +
        (item.publisher.kind === 'github'
          ? 'they hold that GitHub account before it would take this name.'
          : 'they control that domain, through its DNS, before it would take this name.')));
    }
    rows.push(detail('Runs', mcpTransport(config) === 'stdio'
      ? 'On this machine, started by the bridge'
      : `On ${hostOf(config.url)}`));
    if (config.url) rows.push(detail('URL', config.url));
    if (config.command) rows.push(detail('Command', `${config.command} ${(config.args || []).join(' ')}`.trim()));
    if (item.npmPackage) rows.push(detail('Package', packageLine(item)));
    if (item.repository) rows.push(detail('Source', repoLine(item)));
    if (item.updatedAt) rows.push(detail('Listed', `Last updated in the registry ${usage.ago(item.updatedAt)}`));
    if (config.tools?.length) rows.push(detail('Tools', config.tools.join(', ')));
  } else if (item.kind === 'skill') {
    if (config.instructions) rows.push(detail('Instructions', config.instructions));
  }

  return el('div', {}, [
    item.description || item.summary
      ? el('div', { class: 'group' }, [el('div', { class: 'group-note', text: item.description || item.summary })])
      : null,
    el('div', { class: 'group' }, [el('div', { class: 'item-list' }, rows)]),
    item.kind === 'mcp'
      ? el('div', { class: 'group' }, [el('div', { class: 'group-note warn', text: mcpWarning(item, config) })])
      : null,
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