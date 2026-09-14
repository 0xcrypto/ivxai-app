// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* Provider adapters. Every request here goes from the browser to the endpoint
   the user configured, and nowhere else.

   The one detour is the CORS bridge (./bridge.js): when it is switched on, the
   URL is rewritten to travel via a daemon on this machine. That is still the
   user's endpoint and the user's key — it is how you reach a server that will
   not answer a browser directly. `bridge.apply` is a no-op while it is off. */

import * as bridge from './bridge.js';

export const PRESETS = [
  // Local runtimes first: nothing typed into these ever leaves the machine.
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

function networkHint(provider, err) {
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(provider.baseUrl);
  const mixed = location.protocol === 'https:' && provider.baseUrl.startsWith('http:');
  const via = bridge.ready();

  // Through the bridge the browser never sees the endpoint, so none of the
  // browser-imposed reasons below apply and repeating them would mislead.
  if (via) {
    return `The bridge could not reach ${provider.baseUrl}. ${err?.message || ''}`.trim();
  }
  // Everything past here is the browser refusing, not the endpoint failing —
  // so the bridge is the fix, and it is worth saying so every time.
  const offer = ' Settings → Connection turns on the CORS bridge, which reaches ' +
    'endpoints the browser will not.';

  if (mixed && !local) {
    return `Blocked: this page is HTTPS and the endpoint is plain HTTP.${offer}`;
  }
  if (provider.kind === 'ollama') {
    return `Could not reach ${provider.baseUrl}. Either start Ollama with ` +
      `OLLAMA_ORIGINS='${location.origin}', or use the bridge ` +
      '(Settings → Connection).';
  }
  if (local) {
    return `Could not reach ${provider.baseUrl}. Is it running, and does it allow ` +
      `requests from ${location.origin}?${offer}`;
  }
  return `Network or CORS failure calling ${provider.baseUrl}. ${err?.message || ''}`.trim() + offer;
}

async function readError(res) {
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
  const base = res.status === 401 || res.status === 403
    ? 'Rejected by the provider — check the API key'
    : res.status === 429 ? 'Rate limited'
    : `HTTP ${res.status}`;
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

/* ── model listing ─────────────────────────────────────────── */

export async function listModels(provider, apiKey, signal) {
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
    throw new ProviderError(networkHint(provider, err), { cause: err });
  }
  if (!res.ok) throw await readError(res);
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
                                   maxTokens, signal, onDelta }) {
  const base = trimSlash(provider.baseUrl);
  if (!base) throw new ProviderError('No base URL configured');
  if (!model) throw new ProviderError('Pick a model first');

  const emit = (text, reasoning) => onDelta?.({ text: text || '', reasoning: reasoning || '' });
  const result = { text: '', reasoning: '', usage: null, model };
  const push = (text, reasoning) => {
    if (text) result.text += text;
    if (reasoning) result.reasoning += reasoning;
    if (text || reasoning) emit(text, reasoning);
  };

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
    throw new ProviderError(networkHint(provider, err), { cause: err });
  }
  if (!res.ok) throw await readError(res);
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
    models: [],          // what /models reported
    customModels: [],    // what the user typed in by hand
    defaultModel: '',
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
