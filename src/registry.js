// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* The official MCP registry, read as store entries.

   MCP servers are not ours to catalog. There are thousands of them, they move,
   and the people who write them already publish to registry.modelcontextprotocol.io
   — the index the protocol's own project runs. Keeping a hand-written copy of
   any of that in the ai-store repo would mean maintaining a list that is stale
   the week it is merged, so the Store reads the registry directly and the
   catalog keeps what has no upstream: providers, agents and skills.

   Two things follow from that, and both are visible in the Store rather than
   hidden here. It is a third party: turning it on means this app fetches from
   modelcontextprotocol.io while the Store is open, which is why it is a switch
   and not a default. And it is an open index: anyone can publish to it, nobody
   reviews the entries, and a name in it is a claim by its publisher — which is
   why installing one still asks, and says what it will run or where it will
   send your tool calls.

   What comes back is the registry's own schema. This module translates it into
   the item shape the Store already speaks, and nothing here is executed: a
   package entry becomes a command line to show the person, exactly as a pasted
   one would. */

import * as store from './store.js';

/** The registry the protocol project runs. Another index that answers the same
    API can be put in its place from the Store. */
export const DEFAULT_URL = 'https://registry.modelcontextprotocol.io';

const ON_KEY = 'mcpRegistryOn';
const URL_KEY = 'mcpRegistryUrl';

/* Read once at boot and kept here, so a screen can ask whether the registry is
   on while it is painting instead of awaiting storage mid-render. */
let on = false;
let address = DEFAULT_URL;

/** The API caps a page at 100, and a store list longer than that is a search
    the person has not typed yet. */
const PAGE = 100;

const FETCH_TIMEOUT_MS = 20 * 1000;

/** Answers, keyed by the query that fetched them. Memory only: the registry
    is a live index and a day-old copy of it is a lie with a timestamp. */
const answers = new Map();

export async function init() {
  on = Boolean(await store.kvGet(ON_KEY, false));
  address = String(await store.kvGet(URL_KEY, DEFAULT_URL) || DEFAULT_URL).trim();
  answers.clear();
  return on;
}

export const isOn = () => on;
export const url = () => address;

export async function setOn(next) {
  on = Boolean(next);
  answers.clear();
  await store.kvSet(ON_KEY, on);
}

export async function setUrl(next) {
  address = String(next || '').trim() || DEFAULT_URL;
  answers.clear();
  await store.kvSet(URL_KEY, address);
}
export const host = address => { try { return new URL(address).host; } catch { return address; } };

/**
 * Search the registry, or list what it has when the query is empty.
 * Returns store items; throws with a readable message when the registry
 * cannot be reached, so the Store can say so and keep the catalog showing.
 */
export async function search(query = '') {
  const q = String(query || '').trim();
  if (answers.has(q)) return answers.get(q);

  const base = url();
  const endpoint = new URL('/v0/servers', base);
  // `latest` because the registry keeps every published version of a server
  // and the older ones are noise in a list someone is reading.
  endpoint.searchParams.set('version', 'latest');
  endpoint.searchParams.set('limit', String(PAGE));
  if (q) endpoint.searchParams.set('search', q);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let payload;
  try {
    const res = await fetch(endpoint.href, {
      headers: { Accept: 'application/json' }, signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${host(base)} answered ${res.status}`);
    payload = await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`${host(base)} did not answer in time`);
    throw new Error(err.message || String(err));
  } finally {
    clearTimeout(timer);
  }

  const items = (Array.isArray(payload?.servers) ? payload.servers : [])
    .map(toItem)
    .filter(Boolean);
  answers.set(q, items);
  return items;
}

/* ── the registry's schema, as a store entry ───────────────── */

function toItem(entry) {
  const s = entry?.server;
  if (!s?.name) return null;
  const meta = s._meta?.['io.modelcontextprotocol.registry/publisher-provided'] || {};
  const official = entry?._meta?.['io.modelcontextprotocol.registry/official'] || {};
  const config = configOf(s);
  if (!config) return null;      // nothing this app can speak to

  const description = [s.description, needs(s, config)].filter(Boolean).join('\n\n');
  const who = publisher(s.name);
  return {
    // Stable across versions: the same server republished is the same entry,
    // and an install stays recognised as installed.
    id: `mcp:${s.name}`,
    kind: 'mcp',
    registry: true,
    name: meta.title || s.title || shortName(s.name),
    summary: oneLine(s.description) || s.name,
    description,
    // The namespace, not a friendly shortening of it. Three servers can be
    // called Chrome DevTools MCP; only one of them is published from
    // github.com/ChromeDevTools, and that is the difference worth showing.
    author: who.label,
    publisher: who,
    fullName: s.name,
    repository: s.repository?.url || '',
    npmPackage: npmPackage(s),
    updatedAt: official.updatedAt || official.publishedAt || '',
    homepage: s.websiteUrl || s.repository?.url || '',
    version: s.version || '',
    tags: Array.isArray(meta.tags) ? meta.tags.filter(t => typeof t === 'string') : [],
    config,
  };
}

/** The npm package an entry ships, if it ships one: what a download count can
    be asked about. */
function npmPackage(s) {
  const pkg = (Array.isArray(s.packages) ? s.packages : [])
    .find(p => p?.registryType === 'npm' && p.identifier);
  return pkg ? String(pkg.identifier) : '';
}

/** A remote server if it offers one, otherwise the package it ships. */
function configOf(s) {
  const remotes = Array.isArray(s.remotes) ? s.remotes : [];
  const remote = remotes.find(r => r?.url && /^streamable/i.test(r.type || '')) ||
    remotes.find(r => r?.url);
  if (remote) {
    return {
      transport: 'http',
      url: remote.url,
      // Only headers that carry their own value; the ones that want a token
      // are named in the description and filled in by the person.
      headers: Object.fromEntries((remote.headers || [])
        .filter(h => h?.name && (h.value ?? h.default))
        .map(h => [h.name, String(h.value ?? h.default)])),
      viaBridge: false,
    };
  }

  const packages = Array.isArray(s.packages) ? s.packages : [];
  const pkg = packages.find(p => (p?.transport?.type || 'stdio') === 'stdio');
  if (!pkg) return null;
  const line = commandFor(pkg);
  if (!line) return null;
  return {
    transport: 'stdio',
    command: line.command,
    args: line.args,
    // Declared but empty: the names are what the person has to fill in, and an
    // empty value is a visible blank rather than a silent absence.
    env: Object.fromEntries((pkg.environmentVariables || [])
      .filter(v => v?.name)
      .map(v => [v.name, String(v.value ?? v.default ?? '')])),
  };
}

/** The command line a package entry describes. */
function commandFor(pkg) {
  const id = String(pkg.identifier || '').trim();
  if (!id) return null;
  const version = String(pkg.version || '').trim();
  const runtime = flags(pkg.runtimeArguments);
  const tail = flags(pkg.packageArguments);

  switch (pkg.registryType) {
    case 'npm': {
      // `-y` so npx installs without stopping to ask; publishers often put it
      // in runtimeArguments themselves.
      const args = runtime.includes('-y') ? runtime : ['-y', ...runtime];
      return { command: pkg.runtimeHint || 'npx', args: [...args, version ? `${id}@${version}` : id, ...tail] };
    }
    case 'pypi':
      return { command: pkg.runtimeHint || 'uvx', args: [...runtime, version ? `${id}@${version}` : id, ...tail] };
    case 'oci': {
      // Declared variables are forwarded from the environment the bridge sets,
      // which is what `-e NAME` without a value means to docker.
      const pass = (pkg.environmentVariables || []).filter(v => v?.name).flatMap(v => ['-e', v.name]);
      const image = version && !id.includes(':') ? `${id}:${version}` : id;
      return { command: pkg.runtimeHint || 'docker', args: ['run', '-i', '--rm', ...pass, ...runtime, image, ...tail] };
    }
    default:
      // nuget, mcpb and whatever comes next: describable, but not by a command
      // this app can be sure of.
      return null;
  }
}

/** Registry arguments, flattened to the strings a shell would see. An argument
    the publisher left for the user to fill in has no value, and is left out —
    it shows up as the thing to add in the server's own screen. */
function flags(list) {
  const out = [];
  for (const arg of Array.isArray(list) ? list : []) {
    if (!arg || typeof arg !== 'object') continue;
    const value = arg.value ?? arg.default;
    if (arg.type === 'named') {
      if (!arg.name) continue;
      out.push(arg.name);
      if (value !== undefined && value !== null && String(value) !== '') out.push(String(value));
      continue;
    }
    if (value !== undefined && value !== null && String(value) !== '') out.push(String(value));
  }
  return out;
}

/** What the publisher says is still needed before the server will work. */
function needs(s, config) {
  const lines = [];
  if (config.transport === 'http') {
    const wanted = (s.remotes || []).flatMap(r => r.headers || [])
      .filter(h => h?.name && !(h.value ?? h.default));
    if (wanted.length) {
      lines.push(`Needs a header you supply: ${wanted.map(h => h.name).join(', ')}. ` +
        'A bearer token goes in the server’s token field; anything else under Extra headers.');
    }
  } else {
    const required = (s.packages || []).flatMap(p => p.environmentVariables || [])
      .filter(v => v?.name && v.isRequired && !(v.value ?? v.default));
    if (required.length) {
      lines.push(`Needs these environment variables filled in after installing: ${
        required.map(v => v.name).join(', ')}.`);
    }
  }
  return lines.join('\n');
}

/* ── names ─────────────────────────────────────────────────── */

/** `io.github.owner/weather-mcp` -> `weather-mcp`. */
const shortName = name => String(name).split('/').pop() || String(name);

/**
 * Who published this, as somewhere you could go and look.
 *
 * The namespace is not decoration: the registry makes you prove it before it
 * will take a server. `io.github.ChromeDevTools` means whoever pushed this
 * signed in as that GitHub account; `com.stripe` means someone put a record in
 * stripe.com's DNS. So it is turned back into the thing it is a claim about —
 * `github.com/ChromeDevTools`, `stripe.com` — and the way it was proved is
 * kept alongside it.
 */
function publisher(name) {
  const ns = String(name).split('/')[0] || '';
  const github = /^io\.github\.(.+)$/i.exec(ns);
  if (github) {
    return { label: `github.com/${github[1]}`, kind: 'github', namespace: ns };
  }
  return { label: ns.split('.').reverse().join('.'), kind: 'domain', namespace: ns };
}

const oneLine = text => String(text || '').replace(/\s+/g, ' ').trim();
