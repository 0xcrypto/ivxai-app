// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* Put back the Android bits `tauri android init` does not know about.
 *
 * src-tauri/gen/ is generated rather than committed, so there is nowhere in it
 * to keep a change. Anything the Gradle project needs beyond the template has
 * to be reapplied after every init — this script is that step, and it is
 * idempotent so running it against an already-patched project is a no-op.
 *
 * Everything it applies lives in src-tauri/android/. Directories in there are
 * Gradle source sets, copied over the generated ones; files beside them are
 * fragments spliced into the generated build script.
 *
 * What it does:
 *
 *   1. Copies src-tauri/android/<source-set>/ over
 *      gen/android/app/src/<source-set>/, which is how the network security
 *      config and the launcher label get in. See the comments in those files
 *      for why each exists.
 *   2. Points the manifest at that config. Without the attribute the resource
 *      is dead weight, and Android keeps refusing cleartext to the bridge.
 *   3. Appends src-tauri/android/signing.gradle.kts to the app's
 *      build.gradle.kts. Without it Gradle has no signing config at all and
 *      every release APK comes out unsigned.
 *   4. Writes app/tauri.properties, which is where the generated build script
 *      reads the version from and which nothing else ever creates.
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

for (const entry of readdirSync(overlay, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;   // the Gradle fragments, handled below
  cpSync(join(overlay, entry.name), join(app, 'src', entry.name), { recursive: true });
  console.log(`android overlay: src/${entry.name}`);
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

/* Appended rather than spliced into the `android { }` block that is already
   there: Gradle is happy to be configured by a second one, so the fragment
   needs no anchor in a generated file that is free to change under us. The
   marker is what makes running this twice a no-op. */
const buildGradlePath = join(app, 'build.gradle.kts');
const buildGradle = readFileSync(buildGradlePath, 'utf8');
const marker = '// --- appended by scripts/android-overlay.mjs: release signing ---';

if (buildGradle.includes(marker)) {
  console.log('android overlay: build.gradle.kts already has the signing config');
} else {
  const fragment = readFileSync(join(overlay, 'signing.gradle.kts'), 'utf8');
  writeFileSync(buildGradlePath, `${buildGradle.trimEnd()}\n\n${marker}\n${fragment}`);
  console.log('android overlay: build.gradle.kts -> release signing');
}

/* The version, which nothing else puts here.
 *
 * gen/android/app/build.gradle.kts reads these two keys out of
 * tauri.properties and falls back to versionCode 1 and versionName "1.0" when
 * the file is absent — and `tauri android init` does not write it, nor does
 * `tauri android build`. A clean checkout therefore builds an APK stamped 1.0
 * (1) however many times the version has been bumped, which Android treats as
 * older than everything and F-Droid rejects outright.
 *
 * The formula is Tauri's own documented one, so if a future CLI does start
 * writing this file it will write the same numbers:
 *
 *   versionCode = major * 1000000 + minor * 1000 + patch
 *
 * which caps minor and patch at 999 apiece. Cargo.toml is read directly rather
 * than through scripts/version.mjs, which is a command-line tool and would run
 * its own argument handling on import; that script stays the one that *sets*
 * the version, and this only ever reads it.
 */
const cargo = readFileSync(join(root, 'Cargo.toml'), 'utf8');
const version = cargo.match(/\[workspace\.package\][^[]*?\bversion\s*=\s*"([^"]+)"/s)?.[1];
if (!version) {
  console.error('android overlay: no version under [workspace.package] in Cargo.toml');
  process.exit(1);
}

const [major, minor, patch] = version.split('-')[0].split('.').map(Number);
if ([minor, patch].some(part => part > 999)) {
  // Silently wrapping into the next component would produce a version code
  // that goes backwards, and nothing downstream would notice.
  console.error(`android overlay: ${version} does not fit the version code formula`);
  process.exit(1);
}
const versionCode = major * 1000000 + minor * 1000 + patch;

writeFileSync(
  join(app, 'tauri.properties'),
  '// Written by scripts/android-overlay.mjs. Edit Cargo.toml instead.\n' +
    `tauri.android.versionName=${version}\n` +
    `tauri.android.versionCode=${versionCode}\n`,
);
console.log(`android overlay: tauri.properties -> ${version} (${versionCode})`);
