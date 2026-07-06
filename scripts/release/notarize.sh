#!/bin/sh
# Submits the signed bundle to Apple's notary service, waits for the verdict,
# and staples the ticket so Gatekeeper passes offline on first launch.
#
# One-time setup: xcrun notarytool store-credentials nitpick-notary \
#     --apple-id <apple-id> --team-id <team-id>   (password: app-specific)
#
# Usage: notarize.sh [app-path]   (default: dist/Nitpick.app)
set -eu
cd "$(dirname "$0")/../.."
ROOT="$PWD"
. "$ROOT/scripts/release/release.env"

APP="${1:-$ROOT/dist/Nitpick.app}"
[ -d "$APP" ] || { echo "notarize.sh: no bundle at $APP" >&2; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
ditto -c -k --keepParent --norsrc --noextattr --noqtn "$APP" "$WORK/Nitpick.zip"

xcrun notarytool submit "$WORK/Nitpick.zip" \
    --keychain-profile "$NITPICK_NOTARY_PROFILE" --wait
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"

echo "notarize.sh: notarized and stapled $APP"
