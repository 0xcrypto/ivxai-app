// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* DOM helpers and the bottom-sheet stack.

   Every panel in the app — settings, pickers, confirmations — is a screen on
   one sheet. Screens push and pop like a mobile navigation stack, so there is
   never more than one layer of chrome on screen at a time. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined) continue;
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;            // callers pass sanitized markup only
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k in node && k !== 'list') node[k] = v;
    else if (v === false) continue;                       // absent attribute
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/* ── toasts ────────────────────────────────────────────────── */

export function toast(message, kind = '', ms = 4000) {
  const stack = $('#snacks');
  const item = el('div', { class: `snack ${kind}`, text: message, role: 'status' });
  stack.append(item);
  const kill = () => item.remove();
  item.addEventListener('click', kill);
  setTimeout(kill, ms);
  return item;
}

/**
 * A snack that waits for an answer instead of timing out.
 *
 * toast() is for things you only need to notice; this is for the one case
 * where something is being asked of you. It carries an action and stays put
 * until you take it or dismiss it, because a notice that disappears on its
 * own is a notice that gets missed — which is exactly how the old "reload to
 * use it" message failed.
 */
export function actionSnack(message, actionLabel, { onAction, onDismiss } = {}) {
  const stack = $('#snacks');
  const item = el('div', { class: 'snack snack-ask', role: 'status' }, [
    el('span', { class: 'snack-ask-text', text: message }),
    el('button', {
      class: 'snack-ask-go', type: 'button', text: actionLabel,
      onclick: () => onAction?.(),
    }),
    el('button', {
      class: 'snack-ask-x ri-close-line', type: 'button',
      'aria-label': 'Dismiss',
      onclick: () => { item.remove(); onDismiss?.(); },
    }),
  ]);
  stack.append(item);
  return { close: () => item.remove() };
}

/* ── sheet stack ───────────────────────────────────────────── */

let host, sheet, sheetBody, sheetTitle, sheetBack;
const stack = [];
let lastFocus = null;

export function initSheet() {
  host = $('#sheetHost');
  sheet = $('#sheet');
  sheetBody = $('#sheetBody');
  sheetTitle = $('#sheetTitle');
  sheetBack = $('#sheetBack');

  host.addEventListener('click', ev => {
    if (ev.target.closest('[data-sheet-close]')) closeSheet();
  });
  sheetBack.addEventListener('click', () => popScreen());

  document.addEventListener('keydown', ev => {
    if (ev.key !== 'Escape' || host.hidden) return;
    ev.preventDefault();
    if (stack.length > 1) popScreen();
    else closeSheet();
  });

  // Keep focus inside the sheet while it is open.
  document.addEventListener('focusin', ev => {
    if (!host.hidden && !sheet.contains(ev.target) && !$('#snacks').contains(ev.target)) {
      sheet.focus({ preventScroll: true });
    }
  });
}

export const sheetIsOpen = () => host && !host.hidden;

function paint(direction = 'in') {
  const screen = stack[stack.length - 1];
  sheetTitle.textContent = screen.title || '';
  sheetBack.hidden = stack.length < 2;

  // 'none' means we are re-rendering the screen the user is already looking at,
  // so their place in it has to survive. Fetching a model list from a row
  // halfway down otherwise scrolled the answer off the top of the sheet, which
  // read as "nothing happened". A push or a pop is a different screen and
  // rightly starts at the top.
  const inPlace = direction === 'none';
  const scroll = inPlace ? sheetBody.scrollTop : 0;

  clear(sheetBody);
  const node = screen.render();
  node.classList.add('screen');
  // Sliding content in that never went anywhere just adds to the confusion.
  if (inPlace) node.classList.add('still');
  if (direction === 'back') node.classList.add('back');
  sheetBody.append(node);
  sheetBody.scrollTop = scroll;
  const target = node.querySelector('[data-autofocus]');
  if (target) requestAnimationFrame(() => target.focus());
}

export function openSheet(screen) {
  if (!sheetIsOpen()) lastFocus = document.activeElement;
  stack.length = 0;
  stack.push(screen);
  host.hidden = false;
  requestAnimationFrame(() => host.classList.add('open'));
  paint();
}

export function pushScreen(screen) {
  if (!sheetIsOpen()) return openSheet(screen);
  stack.push(screen);
  paint();
}

export function popScreen() {
  if (stack.length < 2) return closeSheet();
  stack.pop().onDismiss?.();
  paint('back');
}

export function closeSheet() {
  if (!sheetIsOpen()) return;
  host.classList.remove('open');
  while (stack.length) stack.pop().onDismiss?.();
  const done = () => {
    host.hidden = true;
    clear(sheetBody);
  };
  sheet.addEventListener('transitionend', done, { once: true });
  setTimeout(done, 400);                                  // in case the transition is suppressed
  lastFocus?.focus?.({ preventScroll: true });
  lastFocus = null;
}

/** Re-render the current screen in place, e.g. after saving a field. */
export function refreshSheet() {
  if (sheetIsOpen()) paint('none');
}

/** Replace the current screen's title without a full re-render. */
export function setSheetTitle(title) {
  if (sheetIsOpen()) sheetTitle.textContent = title;
}

/* ── question screens ──────────────────────────────────────── */

/**
 * Push a screen that asks something and resolves when it is answered, or with
 * null if the user dismisses it. Exported so callers can build richer question
 * screens than confirm/prompt.
 */
export function askScreen(title, render) {
  return new Promise(resolve => {
    let settled = false;
    const nested = sheetIsOpen();
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const screen = {
      title,
      onDismiss: () => finish(null),
      render: () => render(value => {
        finish(value);
        if (nested) popScreen();
        else closeSheet();
      }),
    };
    if (nested) pushScreen(screen);
    else openSheet(screen);
  });
}

const ask = askScreen;

export function confirmAction({ title = 'Are you sure?', body = '', okText = 'Confirm', danger = true }) {
  return ask(title, done => el('div', {}, [
    body ? el('p', { class: 'group-note', text: body }) : null,
    el('div', { class: 'sheet-actions' }, [
      el('button', {
        class: `btn btn-block ${danger ? 'btn-danger' : 'btn-primary'}`,
        type: 'button', text: okText, onclick: () => done(true),
      }),
      el('button', {
        class: 'btn btn-secondary btn-block', type: 'button', text: 'Cancel',
        onclick: () => done(false),
      }),
    ]),
  ])).then(v => v === true);
}

export function promptText({ title = 'Edit', value = '', placeholder = '', multiline = false,
                             type = 'text', okText = 'Save' }) {
  return ask(title, done => {
    const field = multiline
      ? el('textarea', { class: 'form-control', rows: 6, value, placeholder, 'data-autofocus': true })
      : el('input', { class: 'form-control', type, value, placeholder, 'data-autofocus': true,
                      autocomplete: type === 'password' ? 'current-password' : 'off' });

    const submit = () => done(field.value.trim());
    if (!multiline) {
      field.addEventListener('keydown', ev => {
        if (ev.key === 'Enter') { ev.preventDefault(); submit(); }
      });
    }
    return el('form', { onsubmit: ev => { ev.preventDefault(); submit(); } }, [
      el('div', { class: 'field' }, [field]),
      el('div', { class: 'sheet-actions' }, [
        el('button', { class: 'btn btn-primary btn-block', type: 'submit', text: okText }),
        el('button', {
          class: 'btn btn-secondary btn-block', type: 'button', text: 'Cancel',
          onclick: () => done(null),
        }),
      ]),
    ]);
  });
}

/** A list of choices; resolves with the chosen value, or null if dismissed. */
export function chooseFromList({ title, items, selected }) {
  return ask(title, done => el('div', { class: 'item-list' }, items.map(item => el('button', {
    class: `item${item.value === selected ? ' is-active' : ''}`,
    type: 'button',
    onclick: () => done(item.value),
  }, [
    el('span', { class: 'item-main' }, [
      el('span', { class: 'item-title', text: item.label }),
      item.sub ? el('span', { class: 'item-sub', text: item.sub }) : null,
    ]),
    el('span', { class: 'item-check', text: item.value === selected ? '✓' : '' }),
  ]))));
}

/* ── filtering a long list ─────────────────────────────────── */

/**
 * A search field that filters rows already on the screen.
 *
 * Hand it the content you are about to render; rows opt in by carrying
 * `data-search` with the text to match, and a container marked
 * `data-search-group` disappears once nothing in it matches. Returns null when
 * there is too little to be worth searching, so a caller can drop it straight
 * into a children array.
 *
 * It filters by hiding nodes rather than by re-rendering. paint() rebuilds the
 * sheet body from nothing, so going through refreshSheet on every keystroke
 * would destroy the input and take the focus — and a phone's keyboard — with
 * it. Deliberately not autofocused for the same reason: a picker that opens
 * the keyboard over the list it is meant to show helps nobody.
 */
export function searchBar(content, { placeholder = 'Search', minRows = 8 } = {}) {
  const rows = () => $$('[data-search]', content);
  if (rows().length < minRows) return null;

  const empty = el('p', { class: 'group-note', hidden: true });
  const input = el('input', {
    class: 'form-control', type: 'search', placeholder,
    autocomplete: 'off', spellcheck: false, 'aria-label': placeholder,
  });

  const apply = () => {
    const query = input.value.trim().toLowerCase();
    let hits = 0;
    for (const row of rows()) {
      const match = !query || row.dataset.search.includes(query);
      row.hidden = !match;
      if (match) hits += 1;
    }
    for (const group of $$('[data-search-group]', content)) {
      group.hidden = Boolean(query) && !$$('[data-search]', group).some(row => !row.hidden);
    }
    // `:last-child` counts hidden rows, so the last one still on screen has to
    // be told to drop its divider — otherwise it draws against the list's edge.
    for (const list of $$('.item-list', content)) {
      const items = $$('.item', list);
      items.forEach(item => item.classList.remove('is-last'));
      items.filter(item => !item.hidden).pop()?.classList.add('is-last');
    }
    empty.hidden = !query || hits > 0;
    empty.textContent = `Nothing matches “${input.value.trim()}”`;
  };

  input.addEventListener('input', apply);
  // A search input's own clear button fires `search`, not `input`, in Safari.
  input.addEventListener('search', apply);
  // Escape empties the field before the sheet's own handler reads it as "go
  // back" — losing the whole screen because you wanted the list again is rude.
  input.addEventListener('keydown', ev => {
    if (ev.key !== 'Escape' || !input.value) return;
    ev.stopPropagation();
    input.value = '';
    apply();
  });

  return el('div', { class: 'sheet-search' }, [input, empty]);
}

/* ── misc ──────────────────────────────────────────────────── */

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context; fall back to a scratch textarea.
    const ta = el('textarea', { value: text, readOnly: true, tabIndex: -1, 'aria-hidden': 'true' });
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

export function downloadJSON(filename, data) {
  downloadBlob(filename, new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
}

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function relativeTime(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function groupLabel(ts) {
  const day = new Date(ts); day.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / 86400000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return 'Previous 7 days';
  if (diff < 30) return 'Previous 30 days';
  return new Date(ts).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export function autosize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, window.innerHeight * 0.4)}px`;
}
