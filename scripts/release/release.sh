#!/bin/sh
# The whole release, in order: build → sign → verify → notarize → staple →
# package → appcast. Produces dist/releases/Nitpick-<version>-<build>.zip
# and an updated dist/releases/appcast.xml, both ready to upload.
#
# Prerequisites (one-time, documented in docs/release.md):
#   - Developer ID Application certificate in the login Keychain
#   - notarytool credentials profile (see notarize.sh header)
#   - Sparkle EdDSA keypair (generate_keys); public key in release.env
#   - NITPICK_FEED_URL / NITPICK_DOWNLOAD_URL_PREFIX set in release.env
#
# Usage: release.sh <version> <build>     e.g. release.sh 1.0.1 2
#   <version>  marketing version (CFBundleShortVersionString)
#   <build>    monotonically increasing integer (CFBundleVersion) —
#              Sparkle compares THIS to decide what is an update
set -eu
cd "$(dirname "$0")"

[ $# -eq 2 ] || { echo "usage: release.sh <version> <build>" >&2; exit 2; }
VERSION="$1" BUILD="$2"
ROOT="$(cd ../.. && pwd)"
RELEASES="$ROOT/dist/releases"

./bundle.sh --version "$VERSION" --build "$BUILD" --universal
./sign.sh
./verify.sh
./notarize.sh
./verify.sh --notarized --launch

# Package the stapled app; the zip is both the download and Sparkle's
# update enclosure, so it must be built AFTER stapling. The build number is
# part of the name: a build-only re-release must never overwrite a zip an
# existing appcast entry still points at.
mkdir -p "$RELEASES"
ZIP="$RELEASES/Nitpick-$VERSION-$BUILD.zip"
rm -f "$ZIP"
ditto -c -k --keepParent "$ROOT/dist/Nitpick.app" "$ZIP"

./appcast.sh "$RELEASES"

echo
echo "release.sh: done. Publish these so the enclosure URLs resolve:"
echo "  $ZIP"
echo "  $RELEASES/appcast.xml"
