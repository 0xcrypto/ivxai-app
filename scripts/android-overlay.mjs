// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* Put back the Android bits `tauri android init` does not know about.
 *
 * src-tauri/gen/ is generated rather than committed, so there is nowhere in it
 * to keep a change. Anything the Gradle project needs beyond the template has
 * to be reapplied after every init — this script is that step, and it is
 * idempotent so running it against an already-patched project is a no-op.
 *
 * What it does:
 *
 *   1. Copies src-tauri/android/<source-set>/ over
 *      gen/android/app/src/<source-set>/, which is how the network security
 *      config gets in. See the comments in those files for why it exists.
 *   2. Points the manifest at that config. Without the attribute the resource
 *      is dead weight, and Android keeps refusing cleartext to the bridge.
 */

import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const overlay = join(root, 'src-tauri', 'android');
const app = join(root, 'src-tauri', 'gen', 'android', 'app');

if (!existsSync(app)) {
  console.error(
    'android overlay: src-tauri/gen/android is not there yet.\n' +
      '  Run `npm run android:init` first.',
  );
  process.exit(1);
}

for (const set of readdirSync(overlay)) {
  cpSync(join(overlay, set), join(app, 'src', set), { recursive: true });
  console.log(`android overlay: src/${set}`);
}

/* The template writes the application tag with usesCleartextTraffic last, as a
   manifest placeholder Gradle fills in per build type. A config resource wins
   over that attribute on API 24+, which is the point — but only once the
   attribute below names it. */
const manifestPath = join(app, 'src', 'main', 'AndroidManifest.xml');
const manifest = readFileSync(manifestPath, 'utf8');
const attribute = 'android:networkSecurityConfig="@xml/network_security_config"';

if (manifest.includes('android:networkSecurityConfig')) {
  console.log('android overlay: manifest already points at the config');
} else {
  const anchor = /^(\s*)android:usesCleartextTraffic=/m;
  const match = manifest.match(anchor);
  if (!match) {
    // Fail rather than build an APK whose bridge silently cannot be reached.
    console.error(
      `android overlay: no usesCleartextTraffic attribute in ${manifestPath}.\n` +
        '  The Tauri template changed; add networkSecurityConfig by hand.',
    );
    process.exit(1);
  }
  writeFileSync(
    manifestPath,
    manifest.replace(anchor, `${match[1]}${attribute}\n${match[0]}`),
  );
  console.log('android overlay: manifest -> @xml/network_security_config');
}
