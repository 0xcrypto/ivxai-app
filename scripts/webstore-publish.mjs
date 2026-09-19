#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto
//
// Uploads the built Chrome extension to the Chrome Web Store, and optionally
// submits it for review.
//
//   node scripts/webstore-publish.mjs <zip>            upload as a draft
//   node scripts/webstore-publish.mjs <zip> --publish  ...and submit it
//   node scripts/webstore-publish.mjs <zip> --publish --target trustedTesters
//
// Four things have to be in the environment, all of them from the one-time
// setup in scripts/webstore-auth.mjs:
//
//   WEBSTORE_CLIENT_ID       OAuth client, "Desktop app" type
//   WEBSTORE_CLIENT_SECRET
//   WEBSTORE_REFRESH_TOKEN   what webstore-auth.mjs prints
//   WEBSTORE_ITEM_ID         the 32-letter id in the dashboard URL
//
// The store is not a file host: uploading replaces the draft of an item that
// already exists, so the first version has to go up by hand — that is the one
// that carries the listing, the screenshots and the privacy answers, none of
// which this API can write. Everything after it is this script.
//
// Publishing does not make anything live. It submits for review, which takes
// anywhere from an hour to a week, and the store decides.

import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const UPLOAD_URL = id => `https://www.googleapis.com/upload/chromewebstore/v1.1/items/${id}`;
const PUBLISH_URL = (id, target) =>
  `https://www.googleapis.com/chromewebstore/v1.1/items/${id}/publish?publishTarget=${target}`;

const die = msg => { console.error(`webstore: ${msg}`); process.exit(1); };
const log = msg => console.log(`webstore: ${msg}`);

/* ── arguments and environment ─────────────────────────────── */

const args = process.argv.slice(2);
const zipPath = args.find(a => !a.startsWith('--'));
const shouldPublish = args.includes('--publish');
const targetArg = args.indexOf('--target');
const target = targetArg === -1 ? 'default' : args[targetArg + 1];

if (!zipPath) die('give me the zip to upload');
if (!['default', 'trustedTesters'].includes(target)) {
  die(`--target is "default" or "trustedTesters", not "${target}"`);
}
try {
  if (!statSync(zipPath).isFile()) die(`${zipPath} is not a file`);
} catch {
  die(`${zipPath} does not exist — run \`npm run ext:build\` first`);
}

const env = name => {
  const value = process.env[name];
  if (!value) die(`${name} is not set — see packaging/extension/README.md`);
  return value;
};
const clientId = env('WEBSTORE_CLIENT_ID');
const clientSecret = env('WEBSTORE_CLIENT_SECRET');
const refreshToken = env('WEBSTORE_REFRESH_TOKEN');
const itemId = env('WEBSTORE_ITEM_ID');

/* ── talking to the store ──────────────────────────────────── */

/**
 * Trade the long-lived refresh token for an access token.
 *
 * `invalid_grant` here is almost always one thing, and it is not a typo in the
 * secret: a Google Cloud OAuth consent screen left in "Testing" issues refresh
 * tokens that stop working after seven days. Publishing the consent screen, or
 * making it Internal, is the fix, and it is worth saying out loud because the
 * error does not.
 */
async function accessToken() {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (json.error === 'invalid_grant') {
      die('the refresh token was refused (invalid_grant). If the OAuth consent ' +
        'screen is still in "Testing", its refresh tokens expire after 7 days — ' +
        'publish the consent screen, then run `npm run ext:auth` again.');
    }
    die(`could not get an access token: ${json.error_description || json.error || res.status}`);
  }
  return json.access_token;
}

async function upload(token) {
  const zip = readFileSync(zipPath);
  log(`uploading ${basename(zipPath)} (${(zip.length / 1024 / 1024).toFixed(1)} MB) to ${itemId}`);

  const res = await fetch(UPLOAD_URL(itemId), {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'x-goog-api-version': '2',
      'Content-Type': 'application/zip',
    },
    body: zip,
  });
  const json = await res.json().catch(() => ({}));

  // A rejected upload still answers 200; uploadState is the real verdict.
  if (!res.ok || json.uploadState === 'FAILURE') {
    const errors = (json.itemError || []).map(e => e.error_detail || e.error_code).join('; ');
    // By far the most common one, and the message for it is opaque.
    if (/already exists|same version|not_updatable/i.test(errors)) {
      const version = versionOf();
      die(`the store already has ${version ? `version ${version}` : 'this version'} ` +
        'of this item. Bump it with `npm run bump patch`, rebuild, and tag again.');
    }
    die(`upload failed: ${errors || JSON.stringify(json) || res.status}`);
  }
  log(`uploaded, state ${json.uploadState}`);
}

/**
 * The version this zip is for, from its name, for the error above.
 *
 * Read from the filename rather than the manifest inside, which is deflated
 * and so not there to be grepped — the first attempt at this quietly matched
 * nothing and printed "version that".
 */
function versionOf() {
  const m = /-(\d+\.\d+\.\d+[^-]*)-/.exec(basename(zipPath));
  return m ? m[1] : null;
}

async function publish(token) {
  log(`submitting for review (${target})`);
  const res = await fetch(PUBLISH_URL(itemId, target), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'x-goog-api-version': '2',
      'Content-Length': '0',
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    die(`publish failed: ${(json.error?.message) || JSON.stringify(json) || res.status}`);
  }
  const status = (json.status || []).join(', ');
  const detail = (json.statusDetail || []).join('; ');

  // Not an error: the store says this when a listing is incomplete, and it is
  // better to fail the release than to report a submission that never happened.
  if (status && !/OK/i.test(status)) {
    die(`the store did not accept it — ${status}${detail ? `: ${detail}` : ''}`);
  }
  log(`submitted${detail ? `: ${detail}` : ''}`);
  log('review takes anywhere from an hour to a week; the store decides when it goes live');
}

/* ── go ────────────────────────────────────────────────────── */

const token = await accessToken();
await upload(token);
if (shouldPublish) await publish(token);
else log('uploaded as a draft — pass --publish to submit it');
