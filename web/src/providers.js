// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* Provider adapters. Every request here goes from the browser to the endpoint
   the user configured, and nowhere else.

   The one detour is the CORS bridge (./bridge.js): when it is switched on, the
   URL is rewritten to travel via a daemon on this machine. That is still the
   user's endpoint and the user's key — it is how you reach a server that will
   not answer a browser directly. `bridge.apply` is a no-op while it is off.

   The one exception to the rule above is WebLLM: there is no endpoint, the
   model is downloaded once into this browser and every completion is computed
   here, on WebGPU. Nothing leaves the machine once the weights are cached. */

import * as bridge from './bridge.js';
import * as access from './host-access.js';

export const PRESETS = [
  // In-browser runtime first: no server, no key, no account, and no traffic
  // once the weights are in. It is the default so a fresh install can chat
  // without configuring anything.
  { key: 'webllm',     name: 'WebLLM',            kind: 'webllm',    baseUrl: '', needsKey: false, local: true,
    defaultModel: 'gemma-2-2b-it-q4f32_1-MLC', models: ['gemma-2-2b-it-q4f32_1-MLC'],
    hint: 'Runs the model inside this browser on WebGPU. The default (Gemma 2 2B) downloads about 1.5 GB on first use, from HuggingFace, and is cached on disk.' },
  // Local runtimes next: nothing typed into these ever leaves the machine.
  { key: 'ollama',     name: 'Ollama',            kind: 'ollama',    baseUrl: 'http://localhost:11434', needsKey: false, local: true,
    hint: "Ollama blocks browser origins by default. Start it with OLLAMA_ORIGINS set, e.g. OLLAMA_ORIGINS='*' ollama serve" },
  { key: 'lmstudio',   name: 'LM Studio',         kind: 'openai',    baseUrl: 'http://localhost:1234/v1', needsKey: false, local: true,
    hint: 'Developer tab -> start the server, and enable CORS.' },
  { key: 'llamacpp',   name: 'llama.cpp',         kind: 'openai',    baseUrl: 'http://localhost:8080/v1', needsKey: false, local: true,
    hint: 'llama-server serves the OpenAI API on :8080 and allows all origins.' },
  { key: 'jan',        name: 'Jan',               kind: 'openai',    baseUrl: 'http://localhost:1337/v1', needsKey: false, local: true },
  { key: 'vllm',       name: 'vLLM',              kind: 'openai',    baseUrl: 'http://localhost:8000/v1', needsKey: false, local: true,
    hint: 'Start with --allowed-origins to permit browser calls.' },
  { key: 'localai',    name: 'LocalAI',           kind: 'openai',    baseUrl: 'http://localhost:8081/v1', needsKey: false, local: true },
  { key: 'textgen',    name: 'Text generation WebUI', kind: 'openai', baseUrl: 'http://localhost:5000/v1', needsKey: false, local: true },

  { key: 'openrouter', name: 'OpenRouter',        kind: 'openai',    baseUrl: 'https://openrouter.ai/api/v1', needsKey: true,
    hint: 'Key from openrouter.ai/keys' },
  { key: 'openai',     name: 'OpenAI',            kind: 'openai',    baseUrl: 'https://api.openai.com/v1', needsKey: true },
  { key: 'anthropic',  name: 'Anthropic',         kind: 'anthropic', baseUrl: 'https://api.anthropic.com', needsKey: true,
    hint: 'Sent with anthropic-dangerous-direct-browser-access.' },
  { key: 'groq',       name: 'Groq',              kind: 'openai',    baseUrl: 'https://api.groq.com/openai/v1', needsKey: true },
  { key: 'mistral',    name: 'Mistral',           kind: 'openai',    baseUrl: 'https://api.mistral.ai/v1', needsKey: true },
  { key: 'together',   name: 'Together',          kind: 'openai',    baseUrl: 'https://api.together.xyz/v1', needsKey: true },
  { key: 'deepseek',   name: 'DeepSeek',          kind: 'openai',    baseUrl: 'https://api.deepseek.com', needsKey: true },
  { key: 'custom',     name: 'Custom OpenAI-compatible', kind: 'openai', baseUrl: '', needsKey: true },
];

/** Ports worth probing when the user asks us to look for a local runtime. */
export const LOCAL_CANDIDATES = [
  { preset: 'ollama',   host: 'http://localhost:11434' },
  { preset: 'ollama',   host: 'http://127.0.0.1:11434' },
  { preset: 'lmstudio', host: 'http://localhost:1234/v1' },
  { preset: 'llamacpp', host: 'http://localhost:8080/v1' },
  { preset: 'jan',      host: 'http://localhost:1337/v1' },
  { preset: 'vllm',     host: 'http://localhost:8000/v1' },
  { preset: 'localai',  host: 'http://localhost:8081/v1' },
  { preset: 'textgen',  host: 'http://localhost:5000/v1' },
];

export const isLocalUrl = url =>
  /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[a-z0-9-]+\.local)(:\d+)?(\/|$)/i.test(String(url || ''));

/**
 * Probe the usual local endpoints and report which ones answer.
 * Each probe is a normal model-list call, so a hit also means CORS is fine.
 */
export async function scanLocal({ timeoutMs = 2500, onResult } = {}) {
  const found = [];
  await Promise.all(LOCAL_CANDIDATES.map(async candidate => {
    const preset = PRESETS.find(p => p.key === candidate.preset);
    const probe = { ...preset, baseUrl: candidate.host, extraHeaders: {} };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const models = await listModels(probe, '', controller.signal);
      const hit = { preset, baseUrl: candidate.host, models };
      found.push(hit);
      onResult?.(hit);
    } catch {
      /* nothing listening, or it will not talk to a browser */
    } finally {
      clearTimeout(timer);
    }
  }));
  // Prefer localhost over the 127.0.0.1 duplicate of the same runtime.
  const seen = new Set();
  return found.filter(hit => {
    const key = `${hit.preset.key}:${hit.models.join(',')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const KINDS = [
  { value: 'openai', label: 'OpenAI-compatible' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'ollama', label: 'Ollama' },
  { value: 'webllm', label: 'WebLLM (runs in this browser)' },
];

const trimSlash = url => String(url || '').replace(/\/+$/, '');

export class ProviderError extends Error {
  constructor(message, { status = 0, cause = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.cause = cause;
  }
}

async function networkHint(provider, err) {
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(provider.baseUrl);
  const mixed = location.protocol === 'https:' && provider.baseUrl.startsWith('http:');
  const via = bridge.ready();

  // Through the bridge the browser never sees the endpoint, so none of the
  // browser-imposed reasons below apply and repeating them would mislead.
  //
  // It also means this failure cannot be about the endpoint at all. A fetch
  // that throws is a request that got no response, and the only host this
  // page asked for one is the bridge — so the bridge is what has to explain
  // itself. (When the bridge did reach the endpoint and the endpoint failed,
  // it answers with a status and a reason, and that is read elsewhere.)
  if (via) {
    return bridge.explainUnreachable();
  }

  // In the extension, whether the browser applied a CORS rule to this call
  // depends on one thing: has this endpoint been allowed. Granted, the call
  // went out unrewritten and a throw really is the endpoint not answering, so
  // every hint below — all of which blame the browser — would be a wrong
  // answer. Not granted, and it went out as an ordinary cross-origin request,
  // which is a rule about the browser and has a one-tap fix.
  if (bridge.EXTENSION) {
    if (!access.granted(provider.baseUrl)) {
      return `Could not reach ${provider.baseUrl}. This extension has not been ` +
        `allowed to call ${access.hostOf(provider.baseUrl)} — Settings → Providers ` +
        `→ ${provider.name} → Allow access, or use the bridge under CORS bypass.`;
    }
    if (local) {
      return `Could not reach ${provider.baseUrl}. Is it running?`;
    }
    return `Could not reach ${provider.baseUrl}. ${err?.message || ''}`.trim();
  }

  // Everything past here is the browser refusing, not the endpoint failing —
  // so the bridge is the fix, and it is worth saying so every time.
  const offer = ' Settings → CORS bypass turns on the bridge, which reaches ' +
    'endpoints the browser will not.';

  if (mixed && !local) {
    return `Blocked: this page is HTTPS and the endpoint is plain HTTP.${offer}`;
  }
  if (provider.kind === 'ollama') {
    return `Could not reach ${provider.baseUrl}. Either start Ollama with ` +
      `OLLAMA_ORIGINS='${location.origin}', or use the bridge ` +
      '(Settings → CORS bypass).';
  }
  if (local) {
    return `Could not reach ${provider.baseUrl}. Is it running, and does it allow ` +
      `requests from ${location.origin}?${offer}`;
  }
  return `Network or CORS failure calling ${provider.baseUrl}. ${err?.message || ''}`.trim() + offer;
}

/**
 * Name the right culprit for a status the endpoint chose to send.
 *
 * 401 and 403 are not the same fact, and collapsing them into "check the API
 * key" misdirects hardest where there is no key at all: a local runtime that
 * answers 403 is not asking for credentials, it is refusing the caller. That
 * is usually the `Origin` header — a browser attaches one to any cross-origin
 * POST, from an extension page as readily as from a web page, and Ollama and
 * others check it against a list of origins they were told to accept.
 *
 * Which is worth saying plainly in the extension, where it is the one way a
 * provider call still fails for a reason that is not about the provider.
 */
function explainStatus(status, { keyed }) {
  if (status === 401) {
    return keyed
      ? 'Rejected by the provider — check the API key'
      : 'Rejected by the provider — it wants an API key and none is set';
  }
  if (status === 403) {
    if (bridge.EXTENSION) {
      // Two different faults wear this status here, and the extension knows
      // which one it is looking at: either the header it is meant to drop is
      // still going out, or it is not and the endpoint refuses this caller
      // anyway. Only the first is ours to fix, and saying so beats offering
      // both and letting the person guess.
      if (bridge.stripsOrigin() === false) {
        return 'Refused by the endpoint (403), and this extension is still ' +
          `sending Origin: ${location.origin}, which it is built to drop. ` +
          'Reload it on the browser’s extensions page, then try again — or ' +
          'turn on Settings → CORS bypass to go around it';
      }
      return 'Refused by the endpoint (403) — it is turning this caller away ' +
        `rather than asking for a key. For Ollama, add ${location.origin} to ` +
        'OLLAMA_ORIGINS and restart it, or reach it through Settings → CORS bypass';
    }
    return keyed
      ? 'Refused by the provider (403) — the key may not have access to this model'
      : `Refused by the endpoint (403) — it may not accept requests from ${location.origin}`;
  }
  if (status === 429) return 'Rate limited';
  return `HTTP ${status}`;
}

async function readError(res, { apiKey } = {}) {
  let detail = '';
  try {
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      detail = json.error?.message || json.error || json.message || text;
    } catch { detail = text; }
  } catch { /* body already consumed or empty */ }
  if (typeof detail !== 'string') detail = JSON.stringify(detail);
  detail = detail.slice(0, 400);
  const base = explainStatus(res.status, { keyed: Boolean(apiKey) });
  return new ProviderError(detail ? `${base}: ${detail}` : base, { status: res.status });
}

function headersFor(provider, apiKey) {
  const h = { 'Content-Type': 'application/json' };
  if (provider.kind === 'anthropic') {
    if (apiKey) h['x-api-key'] = apiKey;
    h['anthropic-version'] = '2023-06-01';
    h['anthropic-dangerous-direct-browser-access'] = 'true';
  } else if (apiKey) {
    h.Authorization = `Bearer ${apiKey}`;
  }
  for (const [k, v] of Object.entries(provider.extraHeaders || {})) {
    if (k && v) h[k] = v;
  }
  return h;
}

/* ── streaming helpers ─────────────────────────────────────── */

async function* lines(response, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        yield buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield buffer;
  } finally {
    if (signal?.aborted) { try { await reader.cancel(); } catch { /* already gone */ } }
    reader.releaseLock?.();
  }
}

async function* sseData(response, signal) {
  let event = null;
  for await (const line of lines(response, signal)) {
    if (line === '') { event = null; continue; }
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) { event = line.slice(6).trim(); continue; }
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') return;
    try { yield { event, json: JSON.parse(data) }; } catch { /* keepalive / partial */ }
  }
}

/* ── WebLLM: the model runs in this browser, on WebGPU ─────── */

let webllmLib = null;
const webllmEngines = new Map();   // model id -> { promise, state, listeners }

/** The library is code-split and imported only when a WebLLM call needs it:
    it is far too heavy to pay for at boot of an app that may never use it. */
async function webllmLoad() {
  webllmLib ??= await import('@mlc-ai/web-llm');
  return webllmLib;
}

/** Every model id the bundled WebLLM knows, straight from its prebuilt config. */
export async function webllmModelList() {
  const lib = await webllmLoad();
  return [...new Set(lib.prebuiltAppConfig.model_list.map(m => m.model_id))]
    .sort((a, b) => a.localeCompare(b));
}

/* WebLLM asks the adapter for 10 storage buffers per shader stage, and unlike
   every other limit it negotiates — buffer size, binding size, workgroup size,
   each of which it backs off on — this one it simply requires. Firefox answers
   9 today, so an engine there dies on the first message with a sentence about
   shader stages, and only after the model has finished downloading.

   Asked here instead, before the download, and answered in one sentence: the
   shortfall is the browser's to fix, so the count is the browser's business
   and not the reader's. It is a live number, not a verdict — Firefox is
   reworking these limits (bug 2006720), and the day it answers 10 this check
   stops firing on its own, which is what "yet" is doing in the message. */
const WEBLLM_STORAGE_BUFFERS = 10;

async function webllmGpuOrThrow() {
  if (!navigator.gpu) {
    throw new ProviderError('This browser has no WebGPU, and WebLLM runs the model inside the browser on WebGPU.');
  }
  let adapter = null;
  try {
    adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  } catch {
    return;   // no adapter to interrogate; let WebLLM say why in its own words
  }
  if (!adapter) return;

  const buffers = adapter.limits?.maxStorageBuffersPerShaderStage ?? 0;
  if (buffers >= WEBLLM_STORAGE_BUFFERS) return;
  /* Firefox is the browser this is about, and naming it is worth more than
     being vague at someone who can read their own title bar. Any other
     browser short of the limit gets the same sentence about itself rather
     than a claim about Firefox that is not true where it is being read. */
  const firefox = navigator.userAgent.includes('Firefox');
  throw new ProviderError(firefox
    ? 'WebLLM is not supported on this version of Firefox yet.'
    : 'WebLLM is not supported on this version of your browser yet.');
}

/** One engine per model, warm for the life of the page. The promise is cached
    so two chats starting at once share one download instead of racing; the
    latest download state travels with it, so someone joining mid-download
    sees real progress immediately. */
function webllmEngine(model) {
  let entry = webllmEngines.get(model);
  if (!entry) {
    entry = { state: { progress: 0, text: 'Preparing the download…' }, listeners: new Set(), promise: null };
    entry.promise = (async () => {
      await webllmGpuOrThrow();
      const lib = await webllmLoad();
      return lib.CreateMLCEngine(model, {
        initProgressCallback: report => {
          entry.state.progress = report?.progress ?? 0;
          entry.state.text = report?.text || '';
          entry.listeners.forEach(fn => fn(entry.state));
        },
      });
    })();
    webllmEngines.set(model, entry);
    // A failed load must not be remembered as a success, or retrying never
    // actually retries.
    entry.promise.catch(() => webllmEngines.delete(model));
  }
  return entry;
}

/** One line for the chat bubble while the model loads: WebLLM's own report
    already names the stage and its percentage, so pass it through. */
function webllmStatusText(state) {
  const text = String(state.text || '').trim();
  return text ? text.slice(0, 140) : `Loading model… ${Math.round((state.progress || 0) * 100)}%`;
}

async function streamWebLLM({ model, system, messages, temperature, maxTokens, signal, onStatus, push, result }) {
  const entry = webllmEngine(model);
  const onProgress = state => onStatus?.(webllmStatusText(state));
  entry.listeners.add(onProgress);
  // WebLLM takes no AbortSignal; stopping generation is its own call.
  const interrupt = () => { entry.promise.then(
    engine => engine.interruptGenerate().catch(() => { /* engine already gone */ }),
    () => { /* load failed; nothing to interrupt */ },
  ); };
  signal?.addEventListener('abort', interrupt);
  try {
    onProgress(entry.state);
    const engine = await entry.promise;
    // An abort that happened while the engine was still loading only becomes
    // visible here; without this check the load would finish and generate
    // into a chat the user already left.
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const chunks = await engine.chat.completions.create({
      messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(temperature != null ? { temperature } : {}),
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
    });
    for await (const chunk of chunks) {
      if (chunk.usage) {
        result.usage = {
          promptTokens: chunk.usage.prompt_tokens ?? null,
          completionTokens: chunk.usage.completion_tokens ?? null,
        };
      }
      const delta = chunk.choices?.[0]?.delta || {};
      push(delta.content, delta.reasoning_content);
    }
    // Other providers surface a stop as AbortError from the fetch; interrupting
    // WebLLM merely ends the stream, so raise it here to keep the one meaning.
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  } finally {
    signal?.removeEventListener('abort', interrupt);
  }
}

/* ── model listing ─────────────────────────────────────────── */

export async function listModels(provider, apiKey, signal) {
  if (provider.kind === 'webllm') return webllmModelList();
  const base = trimSlash(provider.baseUrl);
  if (!base) throw new ProviderError('No base URL configured');
  const url = provider.kind === 'ollama' ? `${base}/api/tags`
    : provider.kind === 'anthropic' ? `${base}/v1/models?limit=1000`
    : `${base}/models`;

  const [endpoint, headers] = bridge.apply(url, headersFor(provider, apiKey));

  let res;
  try {
    res = await fetch(endpoint, { method: 'GET', headers, signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ProviderError(await networkHint(provider, err), { cause: err });
  }
  if (!res.ok) throw await readError(res, { apiKey });
  const json = await res.json();

  const ids = provider.kind === 'ollama'
    ? (json.models || []).map(m => m.name || m.model)
    : (json.data || json.models || []).map(m => m.id || m.name);

  return [...new Set(ids.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

/* ── chat ──────────────────────────────────────────────────── */

/**
 * Stream a completion. `onDelta({ text, reasoning })` fires per chunk.
 * Resolves with { text, reasoning, usage, model }.
 */
export async function streamChat({ provider, apiKey, model, system, messages, temperature,
                                   maxTokens, signal, onDelta, onStatus }) {
  const base = trimSlash(provider.baseUrl);
  if (!base && provider.kind !== 'webllm') throw new ProviderError('No base URL configured');
  if (!model) throw new ProviderError('Pick a model first');

  const emit = (text, reasoning) => onDelta?.({ text: text || '', reasoning: reasoning || '' });
  const result = { text: '', reasoning: '', usage: null, model };
  const push = (text, reasoning) => {
    if (text) result.text += text;
    if (reasoning) result.reasoning += reasoning;
    if (text || reasoning) emit(text, reasoning);
  };

  if (provider.kind === 'webllm') {
    await streamWebLLM({ model, system, messages, temperature, maxTokens, signal, onStatus, push, result });
    return result;
  }

  let url, body;
  if (provider.kind === 'ollama') {
    url = `${base}/api/chat`;
    body = {
      model, stream: true,
      messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
      options: {
        ...(temperature != null ? { temperature } : {}),
        ...(maxTokens ? { num_predict: maxTokens } : {}),
      },
    };
  } else if (provider.kind === 'anthropic') {
    url = `${base}/v1/messages`;
    body = {
      model, stream: true,
      max_tokens: maxTokens || 4096,
      ...(system ? { system } : {}),
      ...(temperature != null ? { temperature: Math.min(temperature, 1) } : {}),
      messages: messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
    };
  } else {
    url = `${base}/chat/completions`;
    body = {
      model, stream: true,
      messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
      ...(temperature != null ? { temperature } : {}),
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      stream_options: { include_usage: true },
    };
  }

  const [endpoint, headers] = bridge.apply(url, headersFor(provider, apiKey));

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
      referrerPolicy: 'no-referrer',
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ProviderError(await networkHint(provider, err), { cause: err });
  }
  if (!res.ok) throw await readError(res, { apiKey });
  if (!res.body) throw new ProviderError('Provider returned no response body');

  if (provider.kind === 'ollama') {
    for await (const line of lines(res, signal)) {
      if (!line.trim()) continue;
      let json;
      try { json = JSON.parse(line); } catch { continue; }
      if (json.error) throw new ProviderError(String(json.error));
      push(json.message?.content, json.message?.thinking);
      if (json.done) {
        result.usage = {
          promptTokens: json.prompt_eval_count ?? null,
          completionTokens: json.eval_count ?? null,
        };
      }
    }
  } else if (provider.kind === 'anthropic') {
    for await (const { event, json } of sseData(res, signal)) {
      const type = json.type || event;
      if (type === 'error') throw new ProviderError(json.error?.message || 'Provider error');
      if (type === 'content_block_delta') {
        push(json.delta?.text, json.delta?.thinking);
      } else if (type === 'message_start') {
        result.usage = { promptTokens: json.message?.usage?.input_tokens ?? null, completionTokens: null };
      } else if (type === 'message_delta' && json.usage) {
        result.usage = { ...(result.usage || {}), completionTokens: json.usage.output_tokens ?? null };
      }
    }
  } else {
    for await (const { json } of sseData(res, signal)) {
      if (json.error) throw new ProviderError(json.error.message || String(json.error));
      const delta = json.choices?.[0]?.delta || {};
      push(delta.content, delta.reasoning ?? delta.reasoning_content);
      if (json.usage) {
        result.usage = {
          promptTokens: json.usage.prompt_tokens ?? null,
          completionTokens: json.usage.completion_tokens ?? null,
        };
      }
    }
  }

  return result;
}

export function makeProvider(preset) {
  return {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    name: preset.name,
    kind: preset.kind,
    baseUrl: preset.baseUrl,
    preset: preset.key,
    models: [...(preset.models || [])], // what /models reported, or bundled starters
    customModels: [],    // what the user typed in by hand
    defaultModel: preset.defaultModel || '',
    extraHeaders: {},
  };
}

/** Everything the user can pick: fetched plus hand-typed, deduped. */
export const knownModels = provider => [...new Set([
  ...(provider.models || []),
  ...(provider.customModels || []),
])].sort((a, b) => a.localeCompare(b));

/**
 * Keep a hand-typed model around so it survives a later refresh of the
 * fetched list. Returns the cleaned name, or '' if there was nothing to keep.
 */
export function rememberModel(provider, model) {
  const name = String(model || '').trim();
  if (!name) return '';
  if (!Array.isArray(provider.customModels)) provider.customModels = [];
  if (!provider.customModels.includes(name) && !(provider.models || []).includes(name)) {
    provider.customModels.push(name);
  }
  return name;
}
