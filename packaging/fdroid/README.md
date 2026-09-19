# Shipping the Android build

There are two ways onto F-Droid and they are not the same decision.

## Route 1 — F-Droid's own repository

Submit `run.ivx.chat.yml` to [fdroiddata][]. F-Droid then builds the app from
this source on their own machines and signs it with **their** key. Nothing here
signs anything, and no key of ours is involved.

That is the route with the reach — it is the repository every F-Droid install
already has — and the one with the wait. Expect the merge request to sit for
days to weeks, and expect the build recipe to need a round or two: F-Droid's
build server is Debian, and a Tauri app asks it for Rust, an NDK and Node.

The recipe is a draft. Test it against a real fdroidserver before opening the
merge request:

```sh
git clone https://gitlab.com/fdroid/fdroiddata
cd fdroiddata
cp /path/to/ivxai-app/packaging/fdroid/run.ivx.chat.yml metadata/
fdroid rewritemeta run.ivx.chat     # drops the comments, normalises the file
fdroid lint run.ivx.chat
fdroid build -v -l run.ivx.chat     # the long one
```

## Route 2 — our own repository

Run `fdroid` over the APKs the release workflow already builds and publish the
index somewhere, then people add that URL to their F-Droid client. It ships the
same day a tag does, the APKs are the ones we signed, and the cost is that
nobody finds it unless we tell them to.

Nothing in this repository does that yet. The pieces it would need are a repo
signing key, an `fdroid update` step in a workflow, and somewhere to serve
`repo/` from.

The two are not exclusive — most projects that self-host stop once F-Droid
proper accepts them — but an app cannot be installed from both at once, because
the two APKs are signed with different keys.

[fdroiddata]: https://gitlab.com/fdroid/fdroiddata

## The listing

`fastlane/metadata/android/en-US/` at the top of this repository is what
F-Droid reads for the store page, and `fastlane supply` would read the same
directory for Google Play later. Every release wants a new
`changelogs/<versionCode>.txt`; the version code is
`major * 1000000 + minor * 1000 + patch`, so 0.2.2 is `2002`. The release
workflow warns when the file for the version being built is missing.

Screenshots are still missing — see the note in `images/phoneScreenshots/`.

## Signing

See the comments in `src-tauri/android/signing.gradle.kts`. The short version:
make one key, keep it forever, and put it in the repository secrets as
`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and
`ANDROID_KEY_PASSWORD`. Without them the release workflow still runs and still
produces APKs — unsigned ones, which is what F-Droid wants and what no phone
will install.
