#!/bin/sh
# The Sparkle vN → vN+1 drill, end to end on one machine, no Apple account:
# builds 1.0.0 and 1.0.1 with a throwaway EdDSA key, ad-hoc signed, installs
# 1.0.0 under dist/drill/install/, publishes 1.0.1 + appcast on
# http://localhost:8399/, and opens 1.0.0.
#
# The one manual step left: click "nitpick ▸ Check for Updates…" in the
# running app, install, and watch it relaunch as 1.0.1. Ctrl-C this script
# when done (it foregrounds the HTTP server).
set -eu
cd "$(dirname "$0")/../.."
ROOT="$PWD"
DRILL="$ROOT/dist/drill"
PORT=8399

rm -rf "$DRILL"
mkdir -p "$DRILL/install" "$DRILL/serve"

# A previous run's check timestamp or pending-install cache would make this
# drill resume old state instead of exercising a fresh vN → vN+1.
defaults delete ch.liip.nitpick SULastCheckTime 2>/dev/null || true
rm -rf "$HOME/Library/Caches/ch.liip.nitpick/org.sparkle-project.Sparkle"

# Throwaway EdDSA keypair — CryptoKit helper (stock macOS openssl is
# LibreSSL, no ed25519); never touches the Keychain. Line 1 is the private
# seed in Sparkle's key-file format, line 2 the public key.
KEYS="$(swift "$ROOT/scripts/release/eddsa.swift" generate)"
printf '%s\n' "$KEYS" | sed -n 1p > "$DRILL/drill-key.seed"
PUBLIC_KEY="$(printf '%s\n' "$KEYS" | sed -n 2p)"

export NITPICK_FEED_URL="http://localhost:$PORT/appcast.xml"
export NITPICK_ED_PUBLIC_KEY="$PUBLIC_KEY"
export NITPICK_ED_KEY_FILE="$DRILL/drill-key.seed"
export NITPICK_DOWNLOAD_URL_PREFIX="http://localhost:$PORT/"

# v1.0.1 (build 2): the update. Zip it for the appcast, then rebuild v1.0.0.
scripts/release/bundle.sh --version 1.0.1 --build 2
scripts/release/sign.sh --adhoc
scripts/release/verify.sh
ditto -c -k --keepParent --norsrc --noextattr --noqtn "$ROOT/dist/Nitpick.app" "$DRILL/serve/Nitpick-1.0.1.zip"

# v1.0.0 (build 1): the installed app the drill updates from.
scripts/release/bundle.sh --version 1.0.0 --build 1
scripts/release/sign.sh --adhoc
scripts/release/verify.sh
cp -R "$ROOT/dist/Nitpick.app" "$DRILL/install/Nitpick.app"

scripts/release/appcast.sh "$DRILL/serve"

open "$DRILL/install/Nitpick.app"
echo
echo "update-drill: nitpick 1.0.0 is open; the 1.0.1 appcast is being served."
echo "update-drill: click 'nitpick > Check for Updates…', install, and the"
echo "update-drill: app should relaunch as 1.0.1 (check the About panel)."
echo "update-drill: Ctrl-C here when done."
echo
exec python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$DRILL/serve"
