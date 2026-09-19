#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto
//
// Gets the one refresh token the release workflow needs, once.
//
//   WEBSTORE_CLIENT_ID=... WEBSTORE_CLIENT_SECRET=... npm run ext:auth
//
// Before running it, in console.cloud.google.com, on any project:
//
//   1. APIs & Services → Library → enable "Chrome Web Store API".
//   2. OAuth consent screen → External → fill in the three required fields →
//      **Publish app**. Leaving it in Testing is the mistake everyone makes:
//      refresh tokens issued to a testing app die after seven days, and the
//      release then fails weeks later with a message that says `invalid_grant`
//      and nothing about why.
//   3. Credentials → Create credentials → OAuth client ID → **Desktop app**.
//      That type is what allows the loopback redirect this uses.
//
// Then run this, approve in the browser it opens, and put the four values it
// prints into the repository's secrets. The refresh token does not expire once
// the consent screen is published, so this is a one-time thing.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const PORT = 8976;
const REDIRECT = `http://localhost:${PORT}`;
const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';

const die = msg => { console.error(`webstore-auth: ${msg}`); process.exit(1); };

const clientId = process.env.WEBSTORE_CLIENT_ID;
const clientSecret = process.env.WEBSTORE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  die('set WEBSTORE_CLIENT_ID and WEBSTORE_CLIENT_SECRET first (see the header of this file)');
}

/* `access_type=offline` is what asks for a refresh token at all, and
   `prompt=consent` is what makes Google hand one over again on a second run —
   without it an account that has already approved gets an access token only,
   and this prints nothing useful. */
const consentUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: clientId,
  redirect_uri: REDIRECT,
  response_type: 'code',
  scope: SCOPE,
  access_type: 'offline',
  prompt: 'consent',
});

const code = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url, REDIRECT);
    const got = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(got
      ? '<!doctype html><title>Done</title><p>Done — back to the terminal.'
      : `<!doctype html><title>Failed</title><p>${error || 'No code came back.'}`);
    server.close();
    got ? resolve(got) : reject(new Error(error || 'no code in the redirect'));
  });
  server.once('error', e => reject(new Error(
    e.code === 'EADDRINUSE' ? `something is already on port ${PORT}` : e.message)));
  server.listen(PORT, () => {
    console.log(`\nApprove access in the browser. If it did not open:\n\n${consentUrl}\n`);
    spawn('open', [consentUrl], { stdio: 'ignore' }).on('error', () => { /* print above is enough */ });
  });
}).catch(e => die(e.message));

const res = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT,
  }),
});
const json = await res.json().catch(() => ({}));
if (!res.ok) die(`exchange failed: ${json.error_description || json.error || res.status}`);
if (!json.refresh_token) {
  die('Google returned no refresh token. That happens when the account has ' +
    'approved this client before — the request here already sends ' +
    'prompt=consent, so if it persists, remove the app under ' +
    'myaccount.google.com/permissions and run this again.');
}

console.log(`
Put these in the repository's secrets
(Settings → Secrets and variables → Actions → New repository secret):

  WEBSTORE_CLIENT_ID       ${clientId}
  WEBSTORE_CLIENT_SECRET   ${clientSecret}
  WEBSTORE_REFRESH_TOKEN   ${json.refresh_token}
  WEBSTORE_ITEM_ID         the 32 letters in your item's dashboard URL

The refresh token is a credential: it can publish to your store account. Do not
commit it, and do not paste it anywhere that keeps logs.
`);
