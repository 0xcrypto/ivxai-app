// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* Reading someone else's MCP configuration.

   Nobody writes a server down the same way twice. A README says
   `npx add-mcp 'https://api.ahrefs.com/mcp/mcp'`. A docs page pastes JSON
   under `mcpServers`, or `context_servers`, or `servers`, with comments and a
   trailing comma in it because it was copied out of an editor config. All of
   them describe the same two things this app needs to know: a program to
   start, or a URL to post to.

   So the add screen takes the paste as it is and this module works out what it
   says. It is deliberately forgiving — unknown keys are ignored, several
   servers in one paste are all added, and anything it cannot place is left
   blank for the person to fill in on the server's own screen. It reads; it
   never runs. A command line here is text to be taken apart, and the only
   thing that ever starts a process is the bridge, later, when the server is
   actually used. */

/* ── what a paste can say ──────────────────────────────────── */

/** Keys a config file hides its servers under. */
const CONTAINERS = ['mcpServers', 'context_servers', 'contextServers', 'mcp_servers', 'servers'];

/** Where a URL may be spelled out. */
const URL_KEYS = ['url', 'serverUrl', 'server_url', 'httpUrl', 'endpoint', 'uri'];

/** Package runners: `npx foo` is `foo`, as far as reading goes. */
const RUNNERS = new Set(['npx', 'bunx', 'pnpx', 'uvx']);

/** Runner flags that come before the package name. */
const RUNNER_FLAGS = new Set(['-y', '--yes', '-q', '--quiet', '--silent']);

/** Commands whose whole job is "add this server for me": what follows one of
    these is the server itself, not a program to run. */
const INSTALLERS = new Set(['add-mcp', 'mcp-add', 'mcp-install', 'mcp-remote']);

/** Container runners: the name is the image they are handed. */
const CONTAINERS_CMD = new Set(['docker', 'podman', 'nerdctl']);

/** Host labels that name the protocol rather than the vendor. */
const HOST_NOISE = new Set(['www', 'api', 'mcp', 'server', 'app', 'cloud', 'gateway']);

/**
 * Read a pasted URL, command line or JSON config into servers this app can
 * hold. Always resolves to a shape; `error` is the sentence to show when
 * `servers` is empty.
 *
 * @param {string} text  whatever was pasted
 * @param {{taken?: string[]}} options  names already in use, so the ones
 *   handed back are unique from the moment they appear on screen
 * @returns {{servers: object[], error: string}}
 */
export function parseConfig(text, { taken = [] } = {}) {
  const raw = String(text || '').replace(/\r/g, '').trim();
  if (!raw) return fail('Paste a URL, a command, or a JSON config first.');

  const json = readJson(raw);
  if (json) return fromJson(json, new Set(taken));
  if (raw.startsWith('{') || raw.startsWith('[')) {
    return fail('That looks like JSON, but it does not parse. Check for a missing brace, quote or comma.');
  }

  const servers = [];
  for (const line of commandLines(raw)) {
    const one = fromCommand(tokenize(line));
    if (one) servers.push(one);
  }
  if (!servers.length) {
    return fail('Could not tell what that is. Paste the server’s URL, the command that starts it, or a JSON config.');
  }
  return finish(servers, new Set(taken));
}

const fail = error => ({ servers: [], error });

/** The fields mcp.js keeps, with the blanks a person can fill in later. */
function server(fields) {
  const transport = fields.transport === 'stdio' ? 'stdio' : 'http';
  return {
    name: '', url: '', token: '', headers: {}, command: '', args: [], env: {},
    enabled: true,
    ...fields,
    transport,
    // stdio has no other way to reach the machine; a remote server only rides
    // the bridge when it turns out to need it.
    viaBridge: transport === 'stdio',
  };
}

/* ── JSON, as editors actually write it ────────────────────── */

/** The JSON in a paste: the whole thing, or the object inside a command like
    `claude mcp add-json name '{...}'`. */
function readJson(raw) {
  const whole = tryJson(raw);
  if (whole !== undefined) return { value: whole };
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const inner = tryJson(raw.slice(start, end + 1));
  if (inner === undefined) return null;
  return { value: inner, before: raw.slice(0, start) };
}

function tryJson(src) {
  try { return JSON.parse(stripJsonc(src)); } catch { return undefined; }
}

/** Comments and trailing commas, the two things a config file has and JSON
    does not. Quoted strings are walked through rather than matched, so a
    `//` inside a URL stays where it is. */
function stripJsonc(src) {
  let out = '';
  let quote = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      out += c;
      if (c === '\\') { out += src[++i] ?? ''; continue; }
      if (c === '"') quote = false;
      continue;
    }
    if (c === '"') { quote = true; out += c; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); if (i < 0) break; i++; continue; }
    if (c === ',') {
      const next = /[^\s]/.exec(src.slice(i + 1));
      if (next && (next[0] === '}' || next[0] === ']')) continue;   // trailing comma
    }
    out += c;
  }
  return out;
}

function fromJson({ value, before = '' }, names) {
  const entries = serverEntries(value);
  if (!entries) {
    return fail('That JSON has no MCP server in it — expected a `url` or a `command`, or an `mcpServers` block.');
  }
  const hint = nameHint(before);
  const servers = [];
  const skipped = [];
  for (const [key, cfg] of entries) {
    const one = fromEntry(key || hint, cfg);
    if (one) servers.push(one);
    else skipped.push(key || 'one entry');
  }
  if (!servers.length) {
    return fail(`Nothing to add: ${skipped.join(', ')} names neither a url nor a command.`);
  }
  return finish(servers, names);
}

/** The [name, config] pairs in a parsed config, however it was wrapped. */
function serverEntries(value) {
  if (Array.isArray(value)) {
    const items = value.filter(v => v && typeof v === 'object');
    return items.length ? items.map(v => [typeof v.name === 'string' ? v.name : '', v]) : null;
  }
  if (!value || typeof value !== 'object') return null;
  for (const key of CONTAINERS) {
    const held = value[key];
    if (held && typeof held === 'object' && !Array.isArray(held)) return Object.entries(held);
    if (Array.isArray(held)) return serverEntries(held);
  }
  if (looksLikeServer(value)) return [[typeof value.name === 'string' ? value.name : '', value]];
  // A bare map of name -> server, which is what most blocks are without
  // their wrapper key.
  const pairs = Object.entries(value).filter(([, v]) => looksLikeServer(v));
  return pairs.length ? pairs : null;
}

const looksLikeServer = cfg => Boolean(cfg) && typeof cfg === 'object' && !Array.isArray(cfg) &&
  (URL_KEYS.some(k => typeof cfg[k] === 'string') || 'command' in cfg || 'args' in cfg);

function fromEntry(key, cfg) {
  if (typeof cfg === 'string') cfg = isUrl(cfg) ? { url: cfg } : { command: cfg };
  if (!cfg || typeof cfg !== 'object') return null;

  const name = cleanName(key);
  const enabled = cfg.disabled !== true && cfg.enabled !== false;
  const url = URL_KEYS.map(k => cfg[k]).find(v => typeof v === 'string' && v.trim());
  if (url) {
    const { headers, token } = splitAuth(cfg.headers);
    return server({
      // An `sse` server is held as a remote one too: same URL, and the
      // settings screen is where a transport mismatch shows up.
      name: name || nameFromUrl(url), transport: 'http', url: url.trim(),
      token: token || stringOr(cfg.token) || stringOr(cfg.apiKey), headers, enabled,
    });
  }

  const { command, args } = commandOf(cfg);
  if (!command) return null;
  return server({
    name: name || nameFromCommand(command, args), transport: 'stdio',
    command, args, env: stringMap(cfg.env), enabled,
  });
}

/** `command` is usually a program and `args` a list, but it is also written
    as one string, or as the whole argv in one array. */
function commandOf(cfg) {
  let parts = [];
  if (Array.isArray(cfg.command)) parts = cfg.command.map(String);
  else if (typeof cfg.command === 'string') parts = tokenize(cfg.command.trim());
  const args = Array.isArray(cfg.args) ? cfg.args.filter(a => a !== null && a !== undefined).map(String) : [];
  const command = parts.shift() || '';
  return { command, args: [...parts, ...args] };
}

/* ── command lines ─────────────────────────────────────────── */

/** The runnable lines in a paste: continuations joined, prompts and comments
    dropped. Several lines means several servers. */
function commandLines(raw) {
  return raw
    .replace(/\\\n\s*/g, ' ')
    .split('\n')
    .map(line => line.trim().replace(/^[$>#]\s+/, ''))
    .filter(line => line && !line.startsWith('#'));
}

/** Shell-ish splitting: quotes group, backslashes escape, nothing expands. */
export function tokenize(line) {
  const out = [];
  let cur = '';
  let quote = '';
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = '';
      else if (c === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === '\'') { quote = c; has = true; continue; }
    if (c === '\\' && i + 1 < line.length) { cur += line[++i]; has = true; continue; }
    if (/\s/.test(c)) { if (has) out.push(cur); cur = ''; has = false; continue; }
    cur += c;
    has = true;
  }
  if (has) out.push(cur);
  return out;
}

function fromCommand(tokens) {
  let rest = tokens.slice();
  const env = {};
  // `KEY=value program …`, the way a README hands over an API key.
  while (rest.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0])) {
    addEnv(env, rest.shift());
  }
  if (!rest.length) return null;

  let name = '';
  let transport = '';
  const headers = {};

  // `claude mcp add [flags] <name> <command…>` carries the name the person
  // already chose, and its flags say what the rest of the line is.
  if (rest[0] === 'claude' && rest[1] === 'mcp' && /^add/.test(rest[2] || '')) {
    const parsed = claudeAdd(rest.slice(3), env, headers);
    name = parsed.name;
    transport = parsed.transport;
    rest = parsed.rest;
  }

  const installer = stripInstaller(rest);
  rest = installer.rest;
  if (!rest.length) return null;

  // A line that is only a URL is a remote server. Otherwise the URL has to
  // belong to an installer, or it is just an argument of a program to run —
  // `npx some-server --site https://example.com` starts a program.
  const urlAt = rest.findIndex(isUrl);
  const remote = urlAt === 0 || (installer.found && urlAt >= 0) ||
    (transport && transport !== 'stdio' && urlAt >= 0);
  if (remote) {
    const url = rest[urlAt];
    readFlags(rest, headers, env);
    const { headers: rest_headers, token } = splitAuth(headers);
    return server({
      name: cleanName(name) || nameFromUrl(url), transport: 'http', url,
      headers: rest_headers, token,
    });
  }

  // A sentence is not a command line. Anything a shell would recognise has
  // a flag, a path, a package or a version in it somewhere; plain words in a
  // row are someone pasting prose.
  if (rest.length > 1 && rest.every(t => /^[a-z]+$/i.test(t))) return null;

  const [command, ...args] = rest;
  return server({
    name: cleanName(name) || nameFromCommand(command, args), transport: 'stdio',
    command, args, env,
  });
}

/** `npx -y add-mcp <url>` says nothing about npx: the server is what follows
    the installer. Returns what is left, and whether one was there. */
function stripInstaller(tokens) {
  let i = 0;
  if (RUNNERS.has(tokens[0])) i = 1;
  else if ((tokens[0] === 'pnpm' || tokens[0] === 'yarn' || tokens[0] === 'bun') && tokens[1] === 'dlx') i = 2;
  while (i < tokens.length && RUNNER_FLAGS.has(tokens[i])) i++;
  if (INSTALLERS.has(packageName(tokens[i] || ''))) return { rest: tokens.slice(i + 1), found: true };
  return { rest: tokens, found: false };
}

function claudeAdd(args, env, headers) {
  let transport = '';
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { positional.push(...args.slice(i + 1)); break; }
    if (a === '-t' || a === '--transport') { transport = String(args[++i] || '').toLowerCase(); continue; }
    if (a === '-H' || a === '--header') { addHeader(headers, args[++i]); continue; }
    if (a === '-e' || a === '--env') { addEnv(env, args[++i]); continue; }
    if (a.startsWith('-')) { if (!a.includes('=')) i++; continue; }   // --scope user, and friends
    positional.push(a);
  }
  // The first positional is the name — unless it is the URL, because the name
  // was left out.
  const name = positional.length && !isUrl(positional[0]) ? positional.shift() : '';
  return { name, transport, rest: positional };
}

/** `--header "K: V"` and `--env K=V`, wherever an installer put them. */
function readFlags(tokens, headers, env) {
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i];
    if (a === '-H' || a === '--header') addHeader(headers, tokens[++i]);
    else if (a.startsWith('--header=')) addHeader(headers, a.slice(9));
    else if (a === '-e' || a === '--env') addEnv(env, tokens[++i]);
    else if (a.startsWith('--env=')) addEnv(env, a.slice(6));
  }
}

function addHeader(headers, raw) {
  const text = String(raw || '');
  const at = text.indexOf(':');
  if (at <= 0) return;
  headers[text.slice(0, at).trim()] = text.slice(at + 1).trim();
}

function addEnv(env, raw) {
  const text = String(raw || '');
  const at = text.indexOf('=');
  if (at <= 0) return;
  env[text.slice(0, at).trim()] = text.slice(at + 1);
}

/* ── odds and ends ─────────────────────────────────────────── */

const isUrl = value => typeof value === 'string' && /^https?:\/\//i.test(value);

const stringOr = v => (typeof v === 'string' ? v.trim() : '');

const stringMap = value => (value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value)
      .filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))
      .map(([k, v]) => [k, String(v)]))
  : {});

/** A bearer token is kept as the token, because that is the field the server
    screen shows and hides. Anything else stays a header. */
function splitAuth(raw) {
  const headers = {};
  let token = '';
  for (const [key, value] of Object.entries(stringMap(raw))) {
    const bearer = key.toLowerCase() === 'authorization' && /^bearer\s+(.+)$/i.exec(value);
    if (bearer) token = bearer[1].trim();
    else headers[key] = value;
  }
  return { headers, token };
}

/** The name a person typed before pasting JSON at a CLI:
    `claude mcp add-json ahrefs '{…}'` means they called it ahrefs. */
function nameHint(before) {
  const tokens = tokenize(String(before || '').trim())
    .filter(t => t && !t.startsWith('-') && !RUNNERS.has(t));
  const known = new Set(['claude', 'mcp', 'add', 'add-json', 'install', 'code', 'cursor', 'gemini', 'codex']);
  const words = tokens.filter(t => !known.has(t) && !INSTALLERS.has(packageName(t)));
  return words.length ? words[words.length - 1] : '';
}

/** `@scope/name@version` -> `name`, `/usr/bin/foo` -> `foo`. */
function packageName(spec) {
  return String(spec).split('/').pop().replace(/(?!^)@[^@]+$/, '');
}

function nameFromUrl(url) {
  let host = '';
  try { host = new URL(url).hostname; }
  catch { host = String(url).replace(/^https?:\/\//i, '').split('/')[0]; }
  const parts = host.split('.').filter(Boolean);
  if (parts.length > 1) parts.pop();                        // the TLD names nobody
  while (parts.length > 1 && HOST_NOISE.has(parts[0])) parts.shift();
  return slug(parts[parts.length - 1] || host) || 'mcp-server';
}

function nameFromCommand(command, args = []) {
  // What is being run, rather than what runs it: the package a runner was
  // handed, or the image a container line names.
  const subject = CONTAINERS_CMD.has(packageName(command))
    ? args.find(a => !a.startsWith('-') && /[/:]/.test(a) && !/^[./~]/.test(a))
    : RUNNERS.has(command)
      ? args.find(a => !a.startsWith('-') && !/^[./~]/.test(a) && /[a-z]/i.test(a))
      : '';
  const whole = packageName(String(subject || command).replace(/:[^:/]+$/, ''))
    .replace(/\.(js|mjs|cjs|ts|py|rb|sh|exe)$/i, '');
  // `mcp-server-fetch` is fetch; `server-filesystem` is filesystem. When the
  // trimming leaves nothing that names anything, keep what was there.
  const trimmed = whole
    .replace(/^(mcp[-_]?)?server[-_]/i, '')
    .replace(/[-_]mcp([-_]server)?$/i, '')
    .replace(/[-_]server$/i, '');
  const base = /^(mcp|server)?$/i.test(trimmed) ? whole : trimmed;
  return slug(base) || 'mcp-server';
}

const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Kept close to what was written, minus the characters that would confuse a
    `server/tool` name in a tool call. */
const cleanName = s => String(s || '').replace(/[\s/\\]+/g, '-').replace(/^-+|-+$/g, '').trim();

function finish(servers, names) {
  for (const s of servers) {
    s.name = unique(cleanName(s.name) || 'mcp-server', names);
    names.add(s.name);
  }
  return { servers, error: '' };
}

function unique(name, names) {
  if (!names.has(name)) return name;
  for (let n = 2; ; n++) {
    const candidate = `${name}-${n}`;
    if (!names.has(candidate)) return candidate;
  }
}
