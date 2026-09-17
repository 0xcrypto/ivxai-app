// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* Persistence. Everything lives in this browser: IndexedDB for content,
   localStorage for a handful of UI preferences. Nothing is ever uploaded. */

const DB_NAME = 'ivx';
const DB_VERSION = 1;
const UI_KEY = 'ivx.ui';

let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('conversations')) {
        const s = db.createObjectStore('conversations', { keyPath: 'id' });
        s.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains('messages')) {
        const s = db.createObjectStore('messages', { keyPath: 'id' });
        s.createIndex('convId', 'convId');
        s.createIndex('conv_seq', ['convId', 'seq']);
      }
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Database is blocked by another tab'));
  });
  return dbp;
}

function run(storeNames, mode, fn) {
  const names = [].concat(storeNames);
  return open().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(names, mode);
    // fn runs synchronously so its first requests are issued while the
    // transaction is still active; follow-ups chain off request callbacks.
    let started;
    try {
      started = fn(...names.map(n => tx.objectStore(n)));
    } catch (err) {
      try { tx.abort(); } catch { /* already closed */ }
      reject(err);
      return;
    }
    const done = Promise.resolve(started);
    done.catch(() => { /* surfaced below */ });
    tx.oncomplete = () => done.then(resolve, reject);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => done.then(
      () => reject(tx.error || new DOMException('Transaction aborted', 'AbortError')),
      reject
    );
  }));
}

const ask = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export const uid = () =>
  Date.now().toString(36) + '-' + crypto.getRandomValues(new Uint32Array(2))
    .reduce((s, n) => s + n.toString(36), '');

/* ── key/value ─────────────────────────────────────────────── */

export async function kvGet(key, fallback = null) {
  const row = await run('kv', 'readonly', s => ask(s.get(key)));
  return row === undefined || row === null ? fallback : row.value;
}
export function kvSet(key, value) {
  return run('kv', 'readwrite', s => ask(s.put({ key, value })));
}
export function kvDelete(key) {
  return run('kv', 'readwrite', s => ask(s.delete(key)));
}
export function kvAll() {
  return run('kv', 'readonly', s => ask(s.getAll()));
}

/* ── conversations ─────────────────────────────────────────── */

export async function listConversations() {
  const all = await run('conversations', 'readonly', s => ask(s.getAll()));
  return all.sort((a, b) => (b.pinned === true) - (a.pinned === true) || b.updatedAt - a.updatedAt);
}

export function getConversation(id) {
  return run('conversations', 'readonly', s => ask(s.get(id)));
}

export function putConversation(conv) {
  return run('conversations', 'readwrite', s => ask(s.put(conv))).then(() => conv);
}

export function newConversation(defaults = {}) {
  const now = Date.now();
  return {
    id: uid(),
    title: '',
    createdAt: now,
    updatedAt: now,
    pinned: false,
    providerId: defaults.providerId ?? null,
    model: defaults.model ?? '',
    systemPrompt: defaults.systemPrompt ?? '',
    temperature: defaults.temperature ?? 0.7,
    maxTokens: defaults.maxTokens ?? null,
    historyLimit: defaults.historyLimit ?? null,
  };
}

export function deleteConversation(id) {
  return run(['conversations', 'messages'], 'readwrite', (convs, msgs) => {
    convs.delete(id);
    const idx = msgs.index('convId');
    return ask(idx.getAllKeys(IDBKeyRange.only(id))).then(keys => {
      keys.forEach(k => msgs.delete(k));
    });
  });
}

export async function deleteAllConversations() {
  return run(['conversations', 'messages'], 'readwrite', (convs, msgs) => {
    convs.clear();
    msgs.clear();
  });
}

/* ── messages ──────────────────────────────────────────────── */

export function listMessages(convId) {
  return run('messages', 'readonly', s => ask(
    s.index('conv_seq').getAll(IDBKeyRange.bound([convId, -Infinity], [convId, Infinity]))
  ));
}

export function putMessage(msg) {
  return run('messages', 'readwrite', s => ask(s.put(msg))).then(() => msg);
}

export function deleteMessage(id) {
  return run('messages', 'readwrite', s => ask(s.delete(id)));
}

export function deleteMessages(ids) {
  return run('messages', 'readwrite', s => { ids.forEach(id => s.delete(id)); });
}

export function clearMessages(convId) {
  return run('messages', 'readwrite', s => {
    const idx = s.index('convId');
    return ask(idx.getAllKeys(IDBKeyRange.only(convId))).then(keys => keys.forEach(k => s.delete(k)));
  });
}

export function newMessage(convId, role, content, seq, extra = {}) {
  return { id: uid(), convId, role, content, seq, createdAt: Date.now(), ...extra };
}

export function allMessages() {
  return run('messages', 'readonly', s => ask(s.getAll()));
}

/* ── bulk import ───────────────────────────────────────────── */

export function importBundle({ conversations = [], messages = [], kv = [] }) {
  return run(['conversations', 'messages', 'kv'], 'readwrite', (c, m, k) => {
    conversations.forEach(x => c.put(x));
    messages.forEach(x => m.put(x));
    kv.forEach(x => k.put(x));
  });
}

export async function wipeEverything() {
  await run(['conversations', 'messages', 'kv'], 'readwrite', (c, m, k) => {
    c.clear(); m.clear(); k.clear();
  });
  try { localStorage.removeItem(UI_KEY); } catch { /* private mode */ }
  if (self.caches) {
    for (const name of await caches.keys()) await caches.delete(name);
  }
}

/* ── UI preferences (localStorage, non-sensitive) ──────────── */

const UI_DEFAULTS = {
  theme: 'auto',
  core: 'modern',
  width: 'narrow',
  sendOnEnter: true,
  lastConvId: null,
  lastAgentId: null,
  shareBaseUrl: '',
  shareShortener: false,
};

export function loadUI() {
  try {
    return { ...UI_DEFAULTS, ...JSON.parse(localStorage.getItem(UI_KEY) || '{}') };
  } catch {
    return { ...UI_DEFAULTS };
  }
}

export function saveUI(ui) {
  try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch { /* ignore */ }
}

export async function estimateUsage() {
  if (!navigator.storage?.estimate) return null;
  try { return await navigator.storage.estimate(); } catch { return null; }
}
