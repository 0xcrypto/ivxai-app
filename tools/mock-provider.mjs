/* A throwaway OpenAI-compatible endpoint for trying the app out without a key.

   node tools/mock-provider.mjs        # listens on http://localhost:8124/v1
   Add it in Settings as an "OpenAI-compatible" provider with that base URL. */

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT || 8124);

const cors = res => {
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
}).listen(PORT, () => console.log(`mock provider on http://localhost:${PORT}/v1`));
