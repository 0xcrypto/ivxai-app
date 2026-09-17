// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* Syntax highlighting for fenced code blocks.

   highlight.js does the parsing, bundled and served from this origin like
   everything else here — no CDN, no runtime fetch. Its grammars live in
   ./highlight-langs.js and are loaded as a separate chunk: they are about
   45 kB gzipped, which is more than the rest of the app put together, and a
   chat with no code in it should not pay for them. The chunk is small enough
   that the service worker still precaches it, so this works offline.

   Until it lands, code renders as plain escaped text and is repainted in
   place when it arrives — see repaintCodeBlocks.

   Security model, same as markdown.js: highlight.js escapes the source it is
   given and emits only its own <span class="hljs-…"> wrappers, and the paths
   that skip it escape by hand. Model output can never inject HTML. */

let hljs = null;
let loading = null;

/** Pull in the grammars. Idempotent; resolves once they are registered. */
export function loadHighlighter() {
  loading ??= import('./highlight-langs.js')
    .then(mod => { hljs = mod.default; })
    .catch(() => { /* highlighting is decoration: code still reads without it */ });
  return loading;
}

/* Auto-detection runs every grammar over the source, so it is kept to the
   languages worth guessing at and to blocks small enough that guessing is
   cheap. A labelled fence never pays this cost. */
const DETECT = ['javascript', 'typescript', 'python', 'json', 'bash', 'xml',
  'css', 'sql', 'go', 'rust', 'yaml', 'diff'];
const DETECT_MAX = 4000;

/* A reply still streaming re-renders on every frame, so the whole block is
   re-highlighted each time. Past this size the parse costs more than the
   colour is worth and the code ships as plain text. */
const HIGHLIGHT_MAX = 50_000;

/* Same escape as markdown.js. Duplicated rather than shared because that
   module imports this one, and a cycle for six lines is a bad trade. */
const escapeHtml = s => s
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

/**
 * Highlight one fenced block.
 *
 * @param {string} code  the block's source, unescaped
 * @param {string} info  the fence's language word, as written ('' if absent)
 * @returns {{ html: string, language: string, pending: boolean }} escaped
 *   HTML, the label for the block's header (what the fence said, or what
 *   detection found), and whether this block is still waiting on the grammars.
 */
export function highlightCode(code, info = '') {
  const label = String(info || '').trim().toLowerCase();
  const plain = { html: escapeHtml(code), language: label || 'text', pending: false };
  if (!code || code.length > HIGHLIGHT_MAX) return plain;

  if (!hljs) {
    loadHighlighter();
    return { ...plain, pending: true };
  }

  // ignoreIllegals: a block that is still streaming is usually invalid — an
  // unclosed string or brace — and half-written code should still colour.
  if (label && hljs.getLanguage(label)) {
    try {
      return { html: hljs.highlight(code, { language: label, ignoreIllegals: true }).value, language: label, pending: false };
    } catch {
      return plain;
    }
  }
  if (label) return plain;   // named a language we do not carry: leave it alone

  if (code.length > DETECT_MAX) return plain;
  try {
    const guess = hljs.highlightAuto(code, DETECT);
    // Relevance below this is noise — a few brackets are enough to "detect"
    // a language in prose or a stack trace.
    if (!guess.language || guess.relevance < 5) return plain;
    return { html: guess.value, language: guess.language, pending: false };
  } catch {
    return plain;
  }
}

/**
 * Colour the blocks that rendered before the grammars arrived.
 *
 * Works on the DOM rather than re-rendering the messages, so it costs nothing
 * for chats without code, keeps the scroll position, and reaches every surface
 * that shows markdown — the chat, a shared preview, a sheet.
 */
export function repaintCodeBlocks(root = document) {
  if (!hljs) return;
  for (const node of root.querySelectorAll('code[data-hl="pending"]')) {
    const head = node.closest('.code-block')?.querySelector('.code-head span');
    const label = head?.textContent.trim() || '';
    // The source is the block's own text — the same thing the Copy button reads.
    const { html, language, pending } = highlightCode(node.textContent, label === 'text' ? '' : label);
    if (pending) return;                  // the grammars went away again; nothing to do
    node.innerHTML = html;                // escaped above, like every other path here
    delete node.dataset.hl;
    if (head) head.textContent = language;
  }
}
