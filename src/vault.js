/* API key storage. Plaintext in IndexedDB by default; AES-GCM with a
   PBKDF2-derived key once the user sets a passphrase. The derived key exists
   only in memory for the life of the tab — nothing to exfiltrate at rest. */

import { kvGet, kvSet, kvDelete } from './store.js';

const PLAIN_KEY = 'secrets';
const VAULT_KEY = 'vault';
const ITERATIONS = 310000;

const b64 = {
  enc: buf => btoa(String.fromCharCode(...new Uint8Array(buf))),
  dec: str => Uint8Array.from(atob(str), c => c.charCodeAt(0)),
};

const state = {
  encrypted: false,   // a vault record exists
  unlocked: false,    // secrets are readable this session
  key: null,          // CryptoKey, memory only
  secrets: {},        // providerId -> api key
};

async function deriveKey(passphrase, salt, iterations) {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function writeVault() {
  const record = await kvGet(VAULT_KEY);
  const salt = b64.dec(record.salt);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(state.secrets));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, state.key, data);
  await kvSet(VAULT_KEY, {
    v: 1, salt: record.salt, iterations: record.iterations,
    iv: b64.enc(iv), data: b64.enc(cipher),
  });
}

async function persist() {
  if (state.encrypted) {
    if (!state.unlocked) throw new Error('Keys are locked');
    await writeVault();
  } else {
    await kvSet(PLAIN_KEY, state.secrets);
  }
}

/** Called once at startup. Returns true when keys are usable right away. */
export async function init() {
  const vault = await kvGet(VAULT_KEY);
  if (vault) {
    state.encrypted = true;
    state.unlocked = false;
    state.secrets = {};
    return false;
  }
  state.encrypted = false;
  state.unlocked = true;
  state.secrets = (await kvGet(PLAIN_KEY)) || {};
  return true;
}

export const status = () => ({ encrypted: state.encrypted, unlocked: state.unlocked });

export async function unlock(passphrase) {
  const vault = await kvGet(VAULT_KEY);
  if (!vault) return true;
  const key = await deriveKey(passphrase, b64.dec(vault.salt), vault.iterations || ITERATIONS);
  let json;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64.dec(vault.iv) }, key, b64.dec(vault.data)
    );
    json = new TextDecoder().decode(plain);
  } catch {
    throw new Error('Wrong passphrase');
  }
  state.key = key;
  state.secrets = JSON.parse(json);
  state.unlocked = true;
  return true;
}

export function lock() {
  if (!state.encrypted) return;
  state.key = null;
  state.secrets = {};
  state.unlocked = false;
}

export async function enable(passphrase) {
  if (state.encrypted) throw new Error('Already encrypted');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  state.key = await deriveKey(passphrase, salt, ITERATIONS);
  await kvSet(VAULT_KEY, { v: 1, salt: b64.enc(salt), iterations: ITERATIONS, iv: '', data: '' });
  state.encrypted = true;
  state.unlocked = true;
  await writeVault();
  await kvDelete(PLAIN_KEY);
}

export async function disable() {
  if (!state.encrypted) return;
  if (!state.unlocked) throw new Error('Unlock first');
  await kvSet(PLAIN_KEY, state.secrets);
  await kvDelete(VAULT_KEY);
  state.encrypted = false;
  state.key = null;
}

export function getKey(providerId) {
  return state.secrets[providerId] || '';
}

export async function setKey(providerId, value) {
  if (value) state.secrets[providerId] = value;
  else delete state.secrets[providerId];
  await persist();
}

export async function removeKey(providerId) {
  delete state.secrets[providerId];
  await persist();
}

/** Only used by the export routine, and only when the user opts in. */
export function exportSecrets() {
  if (state.encrypted && !state.unlocked) throw new Error('Unlock first');
  return { ...state.secrets };
}

export async function importSecrets(secrets) {
  state.secrets = { ...state.secrets, ...secrets };
  await persist();
}
