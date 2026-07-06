# Releasing nitpick

nitpick ships as a signed, notarized direct download (zip) with Sparkle
auto-updates from an appcast — explicitly not the Mac App Store (sandboxing
would break spawning `simctl` and ingesting arbitrary Builds; see the PRD's
distribution decision). `swift run` remains the dev flow; everything here is
the shipping flow.

All scripts live in `scripts/release/`. Config lives in
`scripts/release/release.env` (checked in, nothing secret); every value can
be overridden from the environment.

## One-time setup (per release machine)

`scripts/release/setup-signing.sh` walks through all four steps
interactively and fills `release.env` as it goes; for hosting it sets up a
public GitHub repo with one fixed `updates` release whose assets are the
appcast + zips (enclosure URLs stay stable across versions), after
scrubbing the local-only `.scratch/` and `.codegraph/` paths from git.
The steps, for reference:

1. **Developer ID certificate.** Install a "Developer ID Application"
   certificate + private key in the login Keychain. Copy its name from
   `security find-identity -v -p codesigning` into `NITPICK_SIGNING_IDENTITY`
   in `release.env`.
2. **Notary credentials.** Create an app-specific password for your Apple ID,
   then store it:
   `xcrun notarytool store-credentials nitpick-notary --apple-id <id> --team-id <team>`.
   The profile name matches `NITPICK_NOTARY_PROFILE`.
3. **Sparkle EdDSA keypair.** Run
   `.build/artifacts/sparkle/Sparkle/bin/generate_keys` once (after
   `swift package resolve`). The private key lands in the login Keychain —
   backing it up matters: losing it strands every installed copy on its
   current version. Put the printed public key into `NITPICK_ED_PUBLIC_KEY`.
4. **Hosting.** Pick a static host for `appcast.xml` and the release zips
   (HTTPS). Set `NITPICK_FEED_URL` (the appcast's final URL) and
   `NITPICK_DOWNLOAD_URL_PREFIX` (the directory the zips are served from).

## Cutting a release

```sh
scripts/release/release.sh <version> <build>    # e.g. release.sh 1.0.1 2
```

`<version>` is the marketing version; `<build>` is a monotonically increasing
integer — Sparkle compares **build numbers** to decide what counts as an
update, so never reuse or decrease one.

The script runs the whole ladder and stops on the first failure:

1. `bundle.sh` — universal release build, assembles `dist/Nitpick.app`
   (Info.plist from the template, Sparkle.framework embedded, rpaths fixed).
2. `sign.sh` — codesigns inside-out (Sparkle XPC services → Autoupdate →
   Updater.app → framework → app) with the hardened runtime and **no
   entitlements**: the app must never declare a sandbox.
3. `verify.sh` — structural checks: signature, no
   `com.apple.security.app-sandbox` on the app, required Info.plist keys,
   Sparkle embedded and reachable via rpath, no build-machine paths.
4. `notarize.sh` — zips, submits via `notarytool --wait`, staples the ticket.
5. `verify.sh --notarized --launch` — Gatekeeper assessment (`spctl`),
   staple validation, and a launch smoke test.
6. Packages the **stapled** app as `dist/releases/Nitpick-<version>-<build>.zip`
   (the zip is both the download and Sparkle's update enclosure; the build
   number keeps a re-release from overwriting a published archive). The zip
   carries no AppleDouble (`._*`) metadata entries (`ditto --norsrc
   --noextattr --noqtn`): Archive Utility merges those back into xattrs, but
   CLI `unzip` materializes them as files inside the sealed bundle — breaking
   the signature and making Gatekeeper reject the app as unverifiable.
   `verify.sh --zip` then re-extracts the zip with CLI `unzip` and runs the
   full notarized ladder on that copy, so a metadata regression can't ship.
7. `appcast.sh` — updates `dist/releases/appcast.xml`, EdDSA-signs the new
   enclosure, and re-verifies every signature against `NITPICK_ED_PUBLIC_KEY`
   so a mismatched private key can never ship.

Then upload `Nitpick-<version>-<build>.zip` and `appcast.xml` so the
enclosure URLs resolve — with the GitHub hosting the wizard sets up:

```sh
gh release upload updates dist/releases/Nitpick-<version>-<build>.zip \
    dist/releases/appcast.xml --clobber
```

Keep `dist/releases/` around between releases:
`generate_appcast` extends the existing appcast and keeps the previous
entries.

If notarization is rejected, ask why:
`xcrun notarytool log <submission-id> --keychain-profile nitpick-notary`.

## Verifying an update end to end (no Apple account needed)

```sh
scripts/release/update-drill.sh
```

Builds 1.0.0 and 1.0.1 with a throwaway EdDSA key (CryptoKit helper, never
touches the Keychain), ad-hoc signed, installs 1.0.0 under `dist/drill/install/`,
serves the 1.0.1 zip + appcast on `http://localhost:8399/`, and opens 1.0.0.
Click "nitpick ▸ Check for Updates…", install, and the app relaunches as
1.0.1. Ctrl-C the script when done.

Ad-hoc drill bundles are signed *without* the hardened runtime — its library
validation can refuse an ad-hoc-signed Sparkle.framework, a failure mode that
doesn't exist with Developer ID. Release signing always enables it
(notarization requires it).

## Gatekeeper check on a clean machine

The one check that can't be scripted from the build machine: copy the
released zip to a Mac that has never seen a security override for nitpick,
unzip, and double-click. It must open without any right-click-Open dance.
`spctl --assess --type execute Nitpick.app` on that machine must say
`accepted`, `source=Notarized Developer ID`. Extract with the terminal's
`unzip`, not just Finder — the two disagree about zip metadata, and
`verify.sh --zip` guards exactly the extractor Finder doesn't exercise.

## Sandbox stance

The app declares **no entitlements at all** — in particular no
`com.apple.security.app-sandbox` (`verify.sh` fails the release if one ever
appears). Sparkle's `Downloader.xpc` keeps its own sandbox entitlement
(preserved during signing); that sandboxes Sparkle's downloader process,
not nitpick — `simctl` spawning and Build ingestion are unaffected.
