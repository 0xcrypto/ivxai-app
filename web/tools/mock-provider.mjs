// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* A throwaway OpenAI-compatible endpoint for trying the app out without a key.

   node tools/mock-provider.mjs                 # http://localhost:8124/v1
   node tools/mock-provider.mjs --no-cors      # ...refusing browser origins
   node tools/mock-provider.mjs --check-origin # ...403 to anything with an Origin

   Add it in Settings as an "OpenAI-compatible" provider with that base URL.

   --no-cors answers without a single Access-Control header, which is how
   Ollama and a bare llama.cpp behave out of the box. A page fetching this is
   blocked by the browser before the response is ever read, so it is the thing
   to point at when testing whatever is meant to get around that: the bridge,
   or the extension build, which needs no bridge because an extension page is
   not subject to the rule in the first place.

   --check-origin is the other half, and the meaner one: it answers 403 to any
   request carrying an Origin header, the way Ollama treats an origin missing
   from OLLAMA_ORIGINS. Nothing is blocked by the browser here — the request
   arrives and the server turns it down. That catches what CORS alone cannot:
   a GET carries no Origin and sails through, so models list fine and the thing
   looks like it works, right up until the first POST. */

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT || 8124);
const NO_CORS = process.argv.includes('--no-cors') || process.env.NO_CORS === '1';
const CHECK_ORIGIN = process.argv.includes('--check-origin') || process.env.CHECK_ORIGIN === '1';

const cors = res => {
  if (NO_CORS) return;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
};

const REPLY = `Here is a **mock** reply so you can see streaming, lists and code.

1. Nothing here reaches a real model.
2. Everything you type stays in your browser.

\`\`\`js
const greet = name => \`hello \${name}\`;
console.log(greet('world'));
\`\`\`

| field | value |
| ----- | ----- |
| model | mock-1 |
| cost  | none |
`;

createServer((req, res) => {
  cors(res);

  // Before anything else, as a strict local runtime would: the caller named an
  // origin, the origin is not on the list, so there is no list to consult.
  if (CHECK_ORIGIN && req.headers.origin) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end(`Forbidden: origin ${req.headers.origin} is not allowed`);
    return;
  }

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.url.startsWith('/v1/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'mock-1' }, { id: 'mock-instant' }] }));
    return;
  }

  if (req.url.startsWith('/v1/chat/completions')) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const chunks = REPLY.match(/.{1,12}/gs) || [];
    let i = 0;
    const timer = setInterval(() => {
      if (i >= chunks.length) {
        clearInterval(timer);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: chunks.length } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i++] } }] })}\n\n`);
    }, 25);
    req.on('close', () => clearInterval(timer));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not found' } }));
}).listen(PORT, () => console.log(
  `mock provider on http://localhost:${PORT}/v1` +
  `${NO_CORS ? ' (no CORS headers)' : ''}${CHECK_ORIGIN ? ' (403 to any Origin)' : ''}`));
