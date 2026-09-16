// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, posix, relative, sep } from 'node:path';
import { defineConfig } from 'vite';

/**
 * Stamps the built asset list into public/sw.js.
 *
 * Deliberately not vite-plugin-pwa/Workbox: the whole premise of this app is
 * that every line of shipped JavaScript is auditable and ours. A precache
 * manifest is a list of strings, so generating it takes ~30 lines rather than
 * a runtime library.
 */
function serviceWorkerPrecache() {
  let outDir = 'dist';
  let base = '/';

  const collect = async (dir, prefix = '') => {
    const entries = await readdir(dir, { withFileTypes: true });
    const out = [];
    for (const entry of entries) {
      const rel = prefix ? posix.join(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) out.push(...await collect(join(dir, entry.name), rel));
      else out.push(rel);
    }
    return out;
  };

  return {
    name: 'ivx:sw-precache',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
      base = config.base;
    },
    async closeBundle() {
      const swPath = join(outDir, 'sw.js');
      let source;
      try {
        source = await readFile(swPath, 'utf8');
      } catch {
        this.warn('sw.js not found in the output; skipping precache injection');
        return;
      }

      const files = (await collect(outDir))
        .map(f => f.split(sep).join('/'))
        .filter(f => f !== 'sw.js')
        .filter(f => !f.endsWith('.map'))
        // fontsource ships a .woff fallback beside every .woff2; no browser
        // that can run this app will ever ask for it, so keep it out of the
        // install payload.
        .filter(f => !f.endsWith('.woff'))
        // A code-split vendor chunk can dwarf the whole shell (WebLLM's is
        // ~6 MB). Precaching it would tax every install with bytes most users
        // never touch; it stays an ordinary same-origin asset, so the fetch
        // handler caches it on first use instead of at install.
        .filter(f => !f.endsWith('.js') || statSync(join(outDir, f)).size <= PRECACHE_MAX_BYTES)
        .sort();

      const urls = files.map(f => `${base}${f}`.replace(/\/{2,}/g, '/'));
      const version = createHash('sha256').update(urls.join('|')).digest('hex').slice(0, 12);

      await writeFile(swPath, source
        .replace('__CACHE_VERSION__', version)
        .replace('__PRECACHE_MANIFEST__', JSON.stringify(urls, null, 2)));

      this.info?.(`sw.js: precaching ${urls.length} files (${version})`);
    },
  };
}

/**
 * Puts the licence notices back on the built assets.
 *
 * The bundle is the form most people actually receive, and it has to say what
 * it is. Rolldown's minifier drops banner comments, and it also strips
 * Halfmoon's own MIT notice — which that licence requires be kept — so both
 * are prepended here after the bundle is written.
 */
function licenceNotices() {
  const js = '/*! ivx/ai Chat | GPL-3.0-or-later | Copyright (C) 2026 0xcrypto\n' +
    ' * Source: https://github.com/ivxlabs/chat */\n';
  const css = '/*! ivx/ai Chat | GPL-3.0-or-later | Copyright (C) 2026 0xcrypto\n' +
    ' * Source: https://github.com/ivxlabs/chat\n' +
    ' * Bundles Halfmoon CSS v2.0.2 (MIT, Copyright (c) 2023 Tahmid Khan)\n' +
    ' * and IBM Plex (SIL Open Font License 1.1, Copyright IBM Corp.) */\n';

  let outDir = 'dist';
  return {
    name: 'ivx:licence-notices',
    apply: 'build',
    configResolved(config) { outDir = config.build.outDir; },
    async closeBundle() {
      const dir = join(outDir, 'assets');
      let entries = [];
      try {
        entries = await readdir(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        const banner = name.endsWith('.js') ? js : name.endsWith('.css') ? css : null;
        if (!banner) continue;
        const file = join(dir, name);
        const body = await readFile(file, 'utf8');
        if (body.startsWith('/*!')) continue;
        await writeFile(file, banner + body);
      }
    },
  };
}

/** Actual installed versions, so the About screen cannot drift from reality. */
const installed = name => {
  try {
    return JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8')).version;
  } catch {
    return '';
  }
};

/* Chunks bigger than this are left out of the service worker's install
   manifest and cached on first use instead — see the filter above. */
const PRECACHE_MAX_BYTES = 2 * 1024 * 1024;

export default defineConfig({
  define: {
    __VERSIONS__: JSON.stringify({
      app: JSON.parse(readFileSync('package.json', 'utf8')).version,
      vite: installed('vite'),
      halfmoon: installed('halfmoon'),
      plex: installed('@fontsource/ibm-plex-sans'),
      webllm: installed('@mlc-ai/web-llm'),
    }),
  },
  // Relative base so the build can be dropped in any directory of any host.
  base: './',
  plugins: [licenceNotices(), serviceWorkerPrecache()],
  build: {
    target: 'es2022',
    cssCodeSplit: false,
    assetsInlineLimit: 0,   // keep fonts and icons as real, cacheable files
    reportCompressedSize: false,
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  preview: {
    port: 4173,
  },
});
