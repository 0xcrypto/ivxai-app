// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* MCP servers: the tools a chat can reach, and how to reach them.

   Two transports, and the difference is where the server runs:

   - `http`  a remote server spoken to with plain fetch, one JSON-RPC POST per
             message (the Streamable HTTP transport). A server that sends its
             own CORS headers is reachable directly; one that does not can be
             routed through the bridge like any other endpoint — a per-server
             toggle, because a CORS failure is a fact about each server.
   - `stdio` a program on this machine. A browser cannot spawn processes, so
             this always goes through the bridge, which starts it and pipes
             JSON-RPC over its stdin/stdout (/mcp/stdio in ivx-bridge). In the
             desktop app the bridge is built in, so it just works there.

   Tools are discovered with tools/list and cached. The cache is what the
   system prompt is built from, and a server that will not answer simply
   contributes no tools — the settings screen is where a broken server is
   diagnosed, not the middle of a chat. */

import * as store from './store.js';
import * as bridge from './bridge.js';

const KV_KEY = 'mcpServers';

/** The newest protocol this client speaks. A server answers with its own
    version, which the spec says to accept, so older servers still pair. */
const PROTOCOL_VERSION = '2025-06-18';

const CLIENT_INFO = { name: 'ivx-ai-chat', version: '0.2.2' };

/** tools/list answers are held this long before being asked for again. */
const TOOLS_TTL_MS = 5 * 60 * 1000;

/** How long one JSON-RPC round-trip may take before it is called failed. */
const RPC_TIMEOUT_MS = 120 * 1000;

let servers = [];     // the installed servers, persisted under KV_KEY

/** Per-server session ids. In memory only: a session is cheap to rebuild and
    expires on the server side anyway. */
const sessions = new Map();   // server id -> { http: '...' | null, stdio: '...' | null }

/** tools/list results per server id: { tools, error, fetchedAt }. */
const catalog = new Map();

/** Server id -> the JSON last persisted for it. See save(). */
const written = new Map();

let rpcSeq = 0;
const nextId = () => ++rpcSeq;

class McpError extends Error {}
/** A cached session went bad; the caller may retry once after a fresh start. */
class StaleSession extends McpError {}

/* ── the installed servers ─────────────────────────────────── */

export async function init() {
  servers = (await store.kvGet(KV_KEY, [])).map(s => Object.assign(s, normalize(s)));
  remember();
  return servers;
}

/** Fill in the fields older saves may not carry, so nothing downstream has
    to guard against undefined. */
function normalize(s) {
  return {
    id: s.id || store.uid(),
    name: s.name || 'Unnamed server',
    enabled: s.enabled !== false,
    transport: s.transport === 'stdio' ? 'stdio' : 'http',
    url: s.url || '',
    token: s.token || '',
    headers: s.headers && typeof s.headers === 'object' ? { ...s.headers } : {},
    command: s.command || '',
    args: Array.isArray(s.args) ? s.args : [],
    env: s.env && typeof s.env === 'object' ? { ...s.env } : {},
    // stdio cannot work without the bridge; a remote server only routes
    // through it when asked, since most speak CORS of their own.
    viaBridge: s.transport === 'stdio' ? true : Boolean(s.viaBridge),
    tools: Array.isArray(s.tools) ? s.tools : [],
    addedAt: s.addedAt || Date.now(),
  };
}

export function list() { return servers; }

export function byId(id) { return servers.find(s => s.id === id) || null; }

export async function save(next) {
  // Filled in on the object it was given rather than on a copy of it: the
  // settings screen holds on to a server across its edits, and a screen
  // editing a copy that was quietly left behind saves nothing.
  const nextList = (next ?? servers).map(s => Object.assign(s, normalize(s)));
  // Only a changed (or removed) server has to lose its cached tools and its
  // live session — a save that touched nothing else should not leave a stdio
  // process orphaned on the bridge until the reaper finds it. The comparison
  // is against what was last written, because by now the live object already
  // carries the change.
  const keep = new Set();
  for (const server of nextList) {
    keep.add(server.id);
    const json = JSON.stringify(server);
    if (written.get(server.id) !== json) invalidate(server.id);
    written.set(server.id, json);
  }
  for (const id of [...written.keys()]) {   // servers that were removed
    if (!keep.has(id)) { written.delete(id); invalidate(id); }
  }
  servers = nextList;
  await store.kvSet(KV_KEY, servers);
  return servers;
}

/** What each server looked like when it was last written, so an edit can be
    told from a save that changed nothing. */
function remember() {
  written.clear();
  for (const server of servers) written.set(server.id, JSON.stringify(server));
}

export function invalidate(id) {
  catalog.delete(id);
  sessions.delete(id);
}

/* ── JSON-RPC over Streamable HTTP ─────────────────────────── */

async function parseHttp(res, requestId) {
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.text();
      detail = JSON.parse(body)?.error?.message || body.slice(0, 200);
    } catch { /* status is all we have */ }
    throw new McpError(`The server answered ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  const type = res.headers.get('content-type') || '';
  const text = await res.text();
  if (!text.trim()) return null;      // a notification's 202, typically
  if (type.includes('text/event-stream')) {
    // The Streamable HTTP reply may arrive as an SSE stream; the message we
    // asked for is whichever data line carries our id.
    let found = null;
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        const json = JSON.parse(line.slice(5).trim());
        if (json?.id === requestId || json?.result || json?.error) found = json;
      } catch { /* not a JSON frame */ }
    }
    return found;
  }
  try { return JSON.parse(text); } catch { throw new McpError('The server sent a reply that is not JSON'); }
}

async function httpRpc(server, body, signal, { withSession = true } = {}) {
  const base = String(server.url || '').trim();
  if (!base) throw new McpError('No URL configured for this server');
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    ...(server.headers || {}),
  };
  if (server.token) headers.Authorization = `Bearer ${server.token}`;
  const httpSession = withSession ? sessions.get(server.id)?.http : null;
  if (httpSession) headers['Mcp-Session-Id'] = httpSession;

  const [endpoint, finalHeaders] = server.viaBridge
    ? bridge.apply(base, headers)
    : [base, headers];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: finalHeaders,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new McpError(`Could not reach ${base}: ${err.message || err}`);
  } finally {
    clearTimeout(timer);
  }
  if (httpSession && res.status === 404) {
    throw new StaleSession('The server dropped our session');
  }
  const announced = res.headers.get('mcp-session-id');
  if (announced) {
    sessions.set(server.id, { ...(sessions.get(server.id) || {}), http: announced });
  }
  return parseHttp(res, body.id);
}

/* ── JSON-RPC over the bridge's stdio sessions ─────────────── */

async function bridgeMcp(payload, signal) {
  const [url, headers] = bridge.self('/mcp/stdio', { 'Content-Type': 'application/json' });
  if (!url) {
    throw new McpError('A local MCP server needs the bridge — Settings → CORS bypass.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
  let res;
  try {
    res = await fetch(url, {
      method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new McpError(`Could not reach the bridge: ${err.message || err}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message || ''; } catch { /* keep status only */ }
    throw new McpError(detail || `The bridge answered ${res.status}`);
  }
  return res.json();
}

async function stdioStart(server) {
  const out = await bridgeMcp({
    action: 'start', command: server.command, args: server.args || [], env: server.env || {},
  });
  const id = out?.sessionId;
  if (!id) throw new McpError('The bridge did not return a session id');
  sessions.set(server.id, { ...(sessions.get(server.id) || {}), stdio: id });
  return id;
}

async function stdioRpc(server, method, params, signal) {
  let sessionId = sessions.get(server.id)?.stdio;
  if (!sessionId) sessionId = await stdioStart(server);
  const message = { jsonrpc: '2.0', id: nextId(), method, ...(params !== undefined ? { params } : {}) };
  let out;
  try {
    out = await bridgeMcp({ action: 'send', sessionId, message }, signal);
  } catch (err) {
    // The process may have been reaped between uses; one silent restart is
    // cheap, and the tools/list cache hides the extra round-trip.
    if (!/session/i.test(err.message || '')) throw err;
    sessionId = await stdioStart(server);
    out = await bridgeMcp({ action: 'send', sessionId, message }, signal);
  }
  return out?.response ?? null;
}

/* ── one JSON-RPC call, either transport ───────────────────── */

async function rpc(server, method, params, signal) {
  if (server.transport === 'stdio') return stdioRpc(server, method, params, signal);
  return httpRpc(server, { jsonrpc: '2.0', id: nextId(), method, ...(params !== undefined ? { params } : {}) }, signal);
}

async function initialize(server, signal) {
  if (server.transport === 'stdio') return;   // the bridge manages the session
  sessions.set(server.id, { ...(sessions.get(server.id) || {}), http: null });
  const res = await httpRpc(server, {
    jsonrpc: '2.0', id: nextId(), method: 'initialize',
    params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
  }, signal, { withSession: false });
  if (res?.error) throw new McpError(res.error.message || 'initialize failed');
  // The handshake is done; the session header, if the server issued one, was
  // kept by httpRpc on the way through.
  sessions.set(server.id, { ...(sessions.get(server.id) || {}), initialized: true });
  // Fire and forget: the answer to this is 202 and empty, and its absence is
  // not worth an error on a server that skips it.
  try {
    await httpRpc(server, { jsonrpc: '2.0', method: 'notifications/initialized' }, signal);
  } catch { /* ignore */ }
}

async function rpcWithRetry(server, method, params, signal) {
  // Streamable HTTP servers want the handshake before anything else; a stdio
  // server got it from its own client side when the bridge started it.
  if (server.transport !== 'stdio' && !sessions.get(server.id)?.initialized) {
    await initialize(server, signal);
  }
  try {
    return await rpc(server, method, params, signal);
  } catch (err) {
    if (!(err instanceof StaleSession)) throw err;
    await initialize(server, signal);
    return await rpc(server, method, params, signal);
  }
}

/* ── tools ─────────────────────────────────────────────────── */

/**
 * The tools a server offers, from tools/list, cached briefly.
 * Returns { tools: [{ name, description, schema }], error: '' | why }.
 */
export async function toolsFor(server, { refresh = false } = {}) {
  // An answer is held for a few minutes; a failure only for a few seconds, so
  // a server that was restarting is not written off for the full TTL.
  const cached = catalog.get(server.id);
  const ttl = cached?.error ? 15 * 1000 : TOOLS_TTL_MS;
  if (!refresh && cached && Date.now() - cached.fetchedAt < ttl) return cached;
  try {
    const res = await rpcWithRetry(server, 'tools/list', {}, null);
    if (res?.error) throw new McpError(res.error.message || 'tools/list failed');
    const tools = (res?.result?.tools || []).map(t => ({
      name: t.name,
      description: t.description || '',
      schema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : {},
    }));
    const entry = { tools, error: '', fetchedAt: Date.now() };
    catalog.set(server.id, entry);
    return entry;
  } catch (err) {
    const entry = { tools: [], error: err.message || String(err), fetchedAt: Date.now() };
    catalog.set(server.id, entry);
    return entry;
  }
}

/** Run one tool. Always resolves; failures come back as `error` for the
    model to read and react to, the way a failed tool should. */
export async function callTool(server, tool, args = {}, signal) {
  try {
    const res = await rpcWithRetry(server, 'tools/call', { name: tool, arguments: args }, signal);
    if (res?.error) return { text: '', error: res.error.message || 'The tool failed' };
    const r = res?.result || {};
    const parts = (r.content || []).map(c => {
      if (c.type === 'text') return c.text;
      if (c.type === 'resource') return c.resource?.text || `[a ${c.resource?.mimeType || 'binary'} resource]`;
      if (c.type === 'image') return '[an image]';
      return `[${c.type || 'unknown'} content]`;
    });
    const text = parts.filter(Boolean).join('\n').trim();
    if (r.isError) {
      return { text: text || 'The tool reported an error without details.', error: text || 'Tool error' };
    }
    return { text: text || '(The tool returned no content.)', error: '' };
  } catch (err) {
    if (err.name === 'AbortError') throw err;   // the user pressed Stop; not a tool failure
    return { text: '', error: err.message || String(err) };
  }
}

/** Connect and list — the settings screen's way of saying why a server
    cannot be used, with names the user can check against what they expect. */
export async function test(server) {
  try {
    if (server.transport === 'http') sessions.delete(server.id);
    const entry = await toolsFor(server, { refresh: true });
    if (entry.error) return { ok: false, tools: [], error: entry.error };
    return { ok: true, tools: entry.tools.map(t => t.name), error: '' };
  } catch (err) {
    return { ok: false, tools: [], error: err.message || String(err) };
  }
}

/* ── the chat's side: prompt, protocol, execution ──────────── */

const oneLine = s => String(s || '').replace(/\s+/g, ' ').trim();

/** A short argument summary the model can follow without a JSON Schema reader:
    `x: string, y: number (optional)`. */
function argSummary(schema) {
  const props = schema?.properties && typeof schema.properties === 'object'
    ? Object.entries(schema.properties) : [];
  if (!props.length) return '';
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const bits = props.map(([name, spec]) => {
    const type = spec?.type || 'any';
    return required.has(name) ? `${name}: ${type}` : `${name}: ${type} (optional)`;
  });
  return `\n  Arguments: ${bits.join(', ')}`;
}

/** The tools the model is offered: the system-prompt section, or ''.
    A server that errors is left out here; its error is settings' business. */
export async function promptSection(denied) {
  const usable = servers.filter(s => s.enabled !== false && !denied?.has(s.id));
  if (!usable.length) return '';
  const lines = [];
  for (const server of usable) {
    const entry = await toolsFor(server);
    if (entry.error || !entry.tools.length) continue;
    const allow = server.tools.length ? new Set(server.tools) : null;
    for (const tool of entry.tools) {
      if (allow && !allow.has(tool.name)) continue;
      lines.push(`- ${server.name}/${tool.name}` +
        (tool.description ? ` — ${oneLine(tool.description)}` : '') +
        argSummary(tool.schema));
    }
  }
  if (!lines.length) return '';
  return '\n\n# Tools\n' +
    'You can use these tools. To call one, output exactly this block:\n' +
    '<tool name="server-name/tool-name">{"argument": "value"}</tool>\n' +
    'The JSON inside is the tool\'s arguments object. You may call several tools ' +
    'in one reply, and you receive each result before you continue.\n' +
    'Available tools:\n' + lines.join('\n');
}

/** Parse one `<tool>` block: the server it names (matched by its configured
    name, longest prefix first) or null when no server answers to it. */
export function resolveToolCall(call, denied) {
  const wanted = String(call.name || '').trim();
  if (!wanted.includes('/')) return null;
  const hit = servers
    .filter(s => s.enabled !== false && !denied?.has(s.id) && wanted.startsWith(`${s.name}/`))
    .sort((a, b) => b.name.length - a.name.length)[0] || null;
  if (!hit) return null;
  const tool = wanted.slice(hit.name.length + 1);
  const allow = hit.tools.length ? new Set(hit.tools) : null;
  if (allow && !allow.has(tool)) return null;
  return { server: hit, tool };
}
