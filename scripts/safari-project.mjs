#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto
//
// Turns the built Safari extension into an Xcode project, and builds it.
//
//   node scripts/safari-project.mjs            generate and build
//   node scripts/safari-project.mjs --no-build just generate the project
//
// Safari does not install a folder of files the way Chrome and Firefox do. It
// installs an app, and the extension rides inside it as an .appex — so this
// step exists for Safari alone, and its output is an app bundle rather than a
// zip. What to do with that app is in packaging/extension/README.md.
//
// Everything here is regenerated from packaging/extension/build/safari, so the
// project is disposable: change the app, rebuild, run this again. Nothing is
// edited by hand inside it, which is why the identifier fixup below is code
// rather than a note telling you to click something in Xcode.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(root, 'packaging', 'extension', 'build', 'safari');
const OUT = join(root, 'packaging', 'safari');

const APP_NAME = 'ivxai-chat';          // target and folder name: no spaces
const DISPLAY_NAME = 'ivx/ai Chat';     // what macOS shows
const APP_ID = 'run.ivx.chat.safari';   // the desktop app is run.ivx.chat
const EXT_ID = `${APP_ID}.Extension`;

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const project = join(OUT, APP_NAME, `${APP_NAME}.xcodeproj`);
const pbxproj = join(project, 'project.pbxproj');

const log = msg => console.log(`safari: ${msg}`);
const die = msg => { console.error(`safari: ${msg}`); process.exit(1); };

if (!existsSync(SOURCE)) die(`${SOURCE} is missing — run \`npm run ext:build\` first`);

/* ── generate ──────────────────────────────────────────────── */

rmSync(OUT, { recursive: true, force: true });
log('converting the extension into an Xcode project');
execFileSync('xcrun', [
  'safari-web-extension-converter', SOURCE,
  '--project-location', OUT,
  '--app-name', APP_NAME,
  '--bundle-identifier', APP_ID,
  '--macos-only', '--no-open', '--no-prompt', '--force',
], { stdio: 'inherit' });

/* ── fix what the converter gets wrong ─────────────────────── */

/* The converter reads --bundle-identifier as the *extension's* id and then
   invents one for the container app from the app name, which lands on
   `run.ivx.chat.ivxai-chat` — not a prefix of the extension's id. Xcode
   refuses to embed an appex whose identifier is not under the parent's, so
   the build fails on ValidateEmbeddedBinary until both are set properly. */
let text = readFileSync(pbxproj, 'utf8');
const before = text;
text = text.replace(/PRODUCT_BUNDLE_IDENTIFIER = "?run\.ivx\.chat\.[\w-]+"?;/g, match =>
  match.includes('Extension')
    ? `PRODUCT_BUNDLE_IDENTIFIER = ${EXT_ID};`
    : `PRODUCT_BUNDLE_IDENTIFIER = ${APP_ID};`);

// The container app should not claim a version of its own; it ships with the
// extension it carries.
text = text.replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${pkg.version};`);

/* A folder name with no spaces, but a real name everywhere a person sees one:
   the Finder and the menu bar for the app, and the line Safari puts in
   Settings → Extensions for the extension — which the converter leaves as
   "ivxai-chat Extension".

   Set here rather than in the two Info.plist files, which would be the obvious
   place and does nothing: Xcode generates the built plist and
   INFOPLIST_KEY_CFBundleDisplayName wins over whatever the source says. */
text = text.replace(/INFOPLIST_KEY_CFBundleDisplayName = "[^"]*";/g,
  `INFOPLIST_KEY_CFBundleDisplayName = "${DISPLAY_NAME}";`);

if (text === before) die('the identifiers were not where they were expected in project.pbxproj');
writeFileSync(pbxproj, text);
log(`identifiers: ${APP_ID} + ${EXT_ID}, version ${pkg.version}`);
log(`display name: ${DISPLAY_NAME}`);

/* ── build ─────────────────────────────────────────────────── */

if (process.argv.includes('--no-build')) {
  log(`project ready: ${project}`);
  process.exit(0);
}

/* Signed ad-hoc ("-"). Not signing at all is not an option: macOS will not run
   an unsigned bundle on Apple silicon, and Safari will not load an extension
   out of one. Ad-hoc is enough for a local install, and is as far as this can
   go without paying Apple — the same place the desktop builds stop. */
log('building');
const derived = join(OUT, 'build');
execFileSync('xcodebuild', [
  '-project', project,
  '-scheme', APP_NAME,
  '-configuration', 'Release',
  '-derivedDataPath', derived,
  'CODE_SIGN_IDENTITY=-',
  'CODE_SIGN_STYLE=Manual',
  'CODE_SIGNING_REQUIRED=YES',
  'CODE_SIGNING_ALLOWED=YES',
  'DEVELOPMENT_TEAM=',
  'build',
], { stdio: ['ignore', 'pipe', 'inherit'] });

const app = join(derived, 'Build', 'Products', 'Release', `${APP_NAME}.app`);
if (!existsSync(app)) die('xcodebuild reported success but produced no app');
log(`built: ${app}`);
log('next: open that app once, then Safari → Settings → Extensions to turn it on');
log('      (an unsigned build also needs Develop → Allow Unsigned Extensions)');
