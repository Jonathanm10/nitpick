#!/bin/sh
# Signs the bundle inside-out: Sparkle's nested pieces first (XPC services,
# Autoupdate, Updater.app), then the framework, then the app.
#
# Release signing (Developer ID) always enables the hardened runtime —
# notarization requires it. The ad-hoc mode used by the local update drill
# omits it: hardened-runtime library validation can refuse to load an
# ad-hoc-signed Sparkle.framework, which would fail the drill for a reason
# that doesn't exist in a real release.
#
# The app itself is signed with NO entitlements file — deliberately. nitpick
# spawns simctl and ingests arbitrary Builds, which sandboxing would break
# (see the PRD's distribution decision); verify.sh asserts the absence.
# Sparkle's Downloader.xpc keeps its own sandbox entitlement
# (--preserve-metadata) — that sandboxes Sparkle's downloader, not nitpick.
#
# Usage: sign.sh [--adhoc] [app-path]   (default app: dist/Nitpick.app)
set -eu
cd "$(dirname "$0")/../.."
ROOT="$PWD"
. "$ROOT/scripts/release/release.env"

APP="$ROOT/dist/Nitpick.app" ADHOC=0
while [ $# -gt 0 ]; do
    case "$1" in
        --adhoc) ADHOC=1; shift ;;
        *) APP="$1"; shift ;;
    esac
done
[ -d "$APP" ] || { echo "sign.sh: no bundle at $APP — run bundle.sh first" >&2; exit 2; }

if [ "$ADHOC" = 1 ]; then
    sign() { codesign --force --sign - "$@"; }
else
    [ -n "$NITPICK_SIGNING_IDENTITY" ] || {
        echo "sign.sh: NITPICK_SIGNING_IDENTITY is empty — set it in scripts/release/release.env" >&2; exit 2; }
    # Secure timestamp required for notarization.
    sign() { codesign --force --options runtime --timestamp \
        --sign "$NITPICK_SIGNING_IDENTITY" "$@"; }
fi

SPARKLE="$APP/Contents/Frameworks/Sparkle.framework"
sign --preserve-metadata=entitlements "$SPARKLE/Versions/B/XPCServices/Downloader.xpc"
sign "$SPARKLE/Versions/B/XPCServices/Installer.xpc"
sign "$SPARKLE/Versions/B/Autoupdate"
sign "$SPARKLE/Versions/B/Updater.app"
sign "$SPARKLE"
sign "$APP"

echo "sign.sh: signed $APP"
