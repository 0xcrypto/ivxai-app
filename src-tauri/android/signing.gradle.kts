/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 0xcrypto
 *
 * Appended to gen/android/app/build.gradle.kts by scripts/android-overlay.mjs.
 * It is a fragment of that file, not a script of its own: it runs with the
 * `com.android.application` plugin already applied, which is what makes the
 * `android { }` accessor below resolve.
 *
 * Tauri's Android template ships no signing configuration at all, so a release
 * build comes out unsigned and no device will install it. This adds one — and
 * only one, deliberately. Debug builds already sign themselves with the
 * throwaway key every Android SDK install carries.
 *
 * Where the key comes from, in order:
 *
 *   1. The environment: ANDROID_KEYSTORE_FILE, ANDROID_KEYSTORE_PASSWORD,
 *      ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD. This is the CI path. The
 *      workflow writes the keystore out of a secret into a temporary
 *      directory, so nothing ever lands in a file that could be committed.
 *   2. gen/android/keystore.properties, with the keys storeFile,
 *      storePassword, keyAlias and keyPassword. The Tauri template already
 *      gitignores that name. This is the path for signing from your own
 *      machine.
 *   3. Neither, in which case the release build stays unsigned on purpose.
 *      That is exactly what F-Droid's build server wants — it signs what it
 *      builds with its own key — and it means anyone without a key can still
 *      run a release build through to the end.
 *
 * Making the key, once. Keep it somewhere you will still have it in five
 * years: an APK signed with a different key cannot upgrade one signed with
 * this one, and there is no way back from losing it but a new application ID.
 *
 *   keytool -genkeypair -v -keystore ivxai-release.jks -storetype PKCS12 \
 *     -keyalg RSA -keysize 4096 -validity 10000 -alias ivxai
 *
 * For the CI secret, base64 it:  base64 -i ivxai-release.jks | pbcopy
 */

/* Parsed by hand rather than with java.util.Properties: inside a Gradle build
   script `java` resolves to Gradle's own extension, so the package name is not
   reachable, and relying on the import the template happens to put at the top
   of this file would make the fragment break the day that changes. */
val ivxKeystore: Map<String, String> = rootProject.file("keystore.properties")
    .takeIf { it.exists() }
    ?.readLines()
    ?.mapNotNull { line ->
        val text = line.trim()
        if (text.startsWith("#") || !text.contains("=")) null
        else text.substringBefore("=").trim() to text.substringAfter("=").trim()
    }
    ?.toMap()
    ?: emptyMap()

fun ivxSecret(env: String, property: String): String? {
    // Spelled out, because getenv returns a platform type and the elvis chain
    // would otherwise be inferred non-null and the takeIf flagged as dead.
    val value: String? = System.getenv(env) ?: ivxKeystore[property]
    return value?.takeIf { it.isNotBlank() }
}

val ivxStoreFile = ivxSecret("ANDROID_KEYSTORE_FILE", "storeFile")

if (ivxStoreFile == null) {
    // An unsigned APK is a legitimate output here, but it is not one you want
    // to find out about after uploading it to a release page.
    logger.lifecycle("ivx: no keystore configured, so the release build will be unsigned")
}

android {
    signingConfigs {
        if (ivxStoreFile != null) {
            create("release") {
                // A relative path is read against gen/android, next to the
                // properties file it came from; an absolute one — what CI
                // passes — comes back unchanged.
                storeFile = rootProject.file(ivxStoreFile)
                storePassword = ivxSecret("ANDROID_KEYSTORE_PASSWORD", "storePassword")
                keyAlias = ivxSecret("ANDROID_KEY_ALIAS", "keyAlias")
                keyPassword = ivxSecret("ANDROID_KEY_PASSWORD", "keyPassword")
            }
        }
    }
    buildTypes {
        getByName("release") {
            if (ivxStoreFile != null) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }
}
