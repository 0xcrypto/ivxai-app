// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* How much a server is actually used.

   The MCP registry has no ratings and no reviews — its API carries none, and
   nothing in it ranks one entry above another. What it does carry is a name
   whose namespace was proved at publish time, and, for most servers, the npm
   or PyPI package they ship. So the question "which of these three identical
   `chrome-devtools-mcp` entries is the real one" is answered here the way it
   is answered anywhere: by who published it and by how many people run it.
   1.5 million installs a week against twenty-four is not a review, but it
   settles that question faster than one would.

   Two more hosts, so two more things worth being plain about: npm is asked for
   weekly download counts, GitHub for stars and the date of the last commit,
   and both learn which packages this browser is looking at. It is a switch in
   Settings for that reason. GitHub is only asked when an entry is opened —
   sixty requests an hour is its limit for a browser with no token, and a list
   would burn that in one scroll. */

import * as store from './store.js';

const ON_KEY = 'mcpUsageOn';

/** On unless turned off: by the time the registry is listing servers, this is
    the difference between a list you can judge and a list you cannot. */
let on = true;

/** npm package -> weekly downloads, or null when it could not be counted.
    Null is remembered too, so a package that 404s is asked about once. */
const weekly = new Map();

/** `owner/name` -> { stars, pushed, archived } or null. */
const repos = new Map();

/** npm takes many names in one request, but only unscoped ones. */
const BULK_MAX = 100;

/** Scoped packages cost a request each, so a page of them is capped rather
    than turned into a hundred round-trips. */
const SCOPED_MAX = 24;

const TIMEOUT_MS = 12 * 1000;

export async function init() {
  on = (await store.kvGet(ON_KEY, true)) !== false;
  return on;
}

export const isOn = () => on;

export async function setOn(next) {
  on = Boolean(next);
  await store.kvSet(ON_KEY, on);
}

/** Weekly downloads for a package: a number, null if unknown, undefined if
    it has not been looked up. Switched off, nothing is known — what was
    fetched earlier is kept, but not shown, so turning it back on is instant
    rather than another round of requests. */
export const downloads = pkg => (on ? weekly.get(pkg) : undefined);

/** Facts about a repository already fetched. Same three-way answer, and the
    same silence when the switch is off. */
export const repo = url => (on ? repos.get(slug(url)) : undefined);

/**
 * Look up the packages these items ship, in as few requests as the npm API
 * allows. Resolves when there is nothing more to learn; the caller repaints.
 */
export async function fetchDownloads(items) {
  if (!on) return;
  const wanted = [...new Set(items
    .map(item => item?.npmPackage)
    .filter(pkg => pkg && !weekly.has(pkg)))];
  if (!wanted.length) return;

  const scoped = wanted.filter(p => p.startsWith('@')).slice(0, SCOPED_MAX);
  const plain = wanted.filter(p => !p.startsWith('@'));

  const jobs = [];
  for (let i = 0; i < plain.length; i += BULK_MAX) {
    const chunk = plain.slice(i, i + BULK_MAX);
    jobs.push(bulk(chunk));
  }
  for (const pkg of scoped) jobs.push(single(pkg));
  await Promise.all(jobs);
}

async function bulk(names) {
  // One name is not a bulk request as far as npm is concerned: it answers with
  // the single-package shape instead of a map.
  if (names.length === 1) return single(names[0]);
  const body = await json(`https://api.npmjs.org/downloads/point/last-week/${names.join(',')}`);
  for (const name of names) {
    const count = body?.[name]?.downloads;
    weekly.set(name, typeof count === 'number' ? count : null);
  }
}

async function single(name) {
  const body = await json(`https://api.npmjs.org/downloads/point/last-week/${name}`);
  weekly.set(name, typeof body?.downloads === 'number' ? body.downloads : null);
}

/**
 * Stars and last commit for the repository an entry names. One request, made
 * when an entry is opened, never for a list.
 */
export async function fetchRepo(url) {
  if (!on) return null;
  const key = slug(url);
  if (!key) return null;
  if (repos.has(key)) return repos.get(key);
  const body = await json(`https://api.github.com/repos/${key}`);
  const facts = body && typeof body.stargazers_count === 'number'
    ? {
        stars: body.stargazers_count,
        pushed: body.pushed_at || '',
        archived: Boolean(body.archived),
        fullName: body.full_name || key,
      }
    : null;
  repos.set(key, facts);
  return facts;
}

/** `https://github.com/owner/name` -> `owner/name`; anything else, nothing. */
function slug(url) {
  const match = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#?]+)/i.exec(String(url || ''));
  if (!match) return '';
  return `${match[1]}/${match[2].replace(/\.git$/, '')}`;
}

async function json(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!res.ok) return null;          // 404, or GitHub's hourly limit reached
    return await res.json();
  } catch {
    return null;                       // offline, blocked, or too slow: no number is shown
  } finally {
    clearTimeout(timer);
  }
}

/** 1516489 -> `1.5M`. The exact figure is noise at this scale; the order of
    magnitude is the whole signal. */
export function compact(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '';
  try {
    return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
  } catch {
    return String(n);
  }
}

/** `2026-09-17T10:38:24Z` -> `today`, `3 days ago`, `5 months ago`. */
export function ago(iso) {
  const then = Date.parse(iso || '');
  if (!Number.isFinite(then)) return '';
  const days = Math.floor((Date.now() - then) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  if (months < 18) return `${months} month${months === 1 ? '' : 's'} ago`;
  return `${Math.round(days / 365)} years ago`;
}
