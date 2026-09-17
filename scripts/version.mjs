#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The version lives in package.json.
//
//   node scripts/version.mjs 0.2.0     set it
//   node scripts/version.mjs patch     bump it (also: minor, major)
//   node scripts/version.mjs --check   fail if anything disagrees
//   node scripts/version.mjs --check v0.2.0   ...including a release tag
//

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = join(root, 'package.json');
const MCP = join(root, 'src/mcp.js');

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const die = msg => { console.error(`version: ${msg}`); process.exit(1); };

const readPkg = () => {
  const text = readFileSync(PKG, 'utf8');
  const pkg = JSON.parse(text);
  return { text, version: pkg.version };
};

function bump(current, kind) {
  const [major, minor, patch] = current.split('-')[0].split('.').map(Number);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function check(tag) {
  const { version } = readPkg();
  const problems = [];
  if (tag) {
    const wanted = tag.replace(/^v/, '');
    if (wanted !== version) problems.push(`tag is ${tag}, package.json is ${version}`);
  }
  if (problems.length) {
    for (const p of problems) console.error(`version: ${p}`);
    console.error('version: run `npm run bump <version>` and commit before tagging');
    process.exit(1);
  }
  console.log(`version: ${version}, everything agrees`);
}

function set(next) {
  if (!SEMVER.test(next)) die(`"${next}" is not a semver version`);

  const { version: current } = readPkg();

  // Rewritten rather than JSON.stringify'd whole, to leave key order and
  // formatting exactly as they were.
  const pkgText = readFileSync(PKG, 'utf8');
  const pkgVersion = /("version"\s*:\s*")([^"]+)(")/;
  if (!pkgVersion.test(pkgText)) die('no version field in package.json');
  writeFileSync(PKG, pkgText.replace(pkgVersion, `$1${next}$3`));

  const mcpText = readFileSync(MCP, 'utf8');
  const mcpVersion = /(\bversion\s*:\s*')([^']+)'/;
  if (mcpVersion.test(mcpText)) {
    writeFileSync(MCP, mcpText.replace(mcpVersion, `$1${next}'`));
  }

  console.log(`version: ${current} -> ${next}`);
  console.log('version: commit this, then tag that commit v' + next);
}

const [arg, tag, ...rest] = process.argv.slice(2);
if (rest.length) die(`unexpected argument "${rest[0]}"`);
if (!arg) {
  console.log(readPkg().version);
} else if (arg === '--check') {
  check(tag);
} else if (['major', 'minor', 'patch'].includes(arg)) {
  // `bump patch 0.2.2` reads as two conflicting instructions — say so rather
  // than silently bumping and dropping the version the caller asked for.
  if (tag) die(`"${arg}" takes no argument — say \`bump ${arg}\` or \`bump ${tag}\`, not both`);
  set(bump(readPkg().version, arg));
} else {
  if (tag) die(`unexpected argument "${tag}"`);
  set(arg);
}
