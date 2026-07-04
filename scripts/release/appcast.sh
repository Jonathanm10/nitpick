#!/bin/sh
# Generates (or updates) appcast.xml over a directory of release zips using
# Sparkle's generate_appcast, which EdDSA-signs every enclosure.
#
# The private key comes from the login Keychain (created once by Sparkle's
# generate_keys), or from a file when NITPICK_ED_KEY_FILE is set — the update
# drill and CI use the file path.
#
# Usage: appcast.sh [archives-dir]   (default: dist/releases)
set -eu
cd "$(dirname "$0")/../.."
ROOT="$PWD"
. "$ROOT/scripts/release/release.env"

ARCHIVES="${1:-$ROOT/dist/releases}"
[ -d "$ARCHIVES" ] || { echo "appcast.sh: no archives directory at $ARCHIVES" >&2; exit 2; }
[ -n "$NITPICK_ED_PUBLIC_KEY" ] || {
    echo "appcast.sh: NITPICK_ED_PUBLIC_KEY is empty — set it in scripts/release/release.env" >&2; exit 2; }

SPARKLE_BIN="$ROOT/.build/artifacts/sparkle/Sparkle/bin"
[ -x "$SPARKLE_BIN/generate_appcast" ] || {
    echo "appcast.sh: generate_appcast not found under .build/artifacts — run swift package resolve" >&2; exit 1; }

set -- # rebuild "$@" as the option list
if [ -n "${NITPICK_ED_KEY_FILE:-}" ]; then
    set -- "$@" --ed-key-file "$NITPICK_ED_KEY_FILE"
fi
if [ -n "$NITPICK_DOWNLOAD_URL_PREFIX" ]; then
    # Without a trailing slash, generate_appcast resolves the prefix like a
    # relative URL base and drops its last path component from enclosures.
    case "$NITPICK_DOWNLOAD_URL_PREFIX" in
        */) PREFIX="$NITPICK_DOWNLOAD_URL_PREFIX" ;;
        *) PREFIX="$NITPICK_DOWNLOAD_URL_PREFIX/" ;;
    esac
    set -- "$@" --download-url-prefix "$PREFIX"
fi

# No delta updates: from the second release on, generate_appcast would
# otherwise emit *.delta files the publish list doesn't cover (404 for
# delta-first clients). The full zip is ~2 MB — deltas buy nothing.
"$SPARKLE_BIN/generate_appcast" --maximum-deltas 0 "$@" "$ARCHIVES"

# generate_appcast exits 0 even when it could not sign, and it signs with
# whatever private key it found — matching SUPublicEDKey or not. Either way
# every installed copy would reject the update. Verify each enclosure's
# EdDSA signature against the configured public key (CryptoKit helper —
# stock macOS openssl is LibreSSL and cannot verify ed25519).
APPCAST="$ARCHIVES/appcast.xml"
grep -q '<enclosure ' "$APPCAST" || {
    echo "appcast.sh: $APPCAST contains no enclosures" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
grep '<enclosure ' "$APPCAST" | while IFS= read -r enclosure; do
    url="$(printf %s "$enclosure" | sed -n 's/.*url="\([^"]*\)".*/\1/p')"
    sig="$(printf %s "$enclosure" | sed -n 's/.*sparkle:edSignature="\([^"]*\)".*/\1/p')"
    [ -n "$sig" ] || {
        echo "appcast.sh: enclosure $url is missing sparkle:edSignature — wrong or missing EdDSA private key?" >&2
        exit 1; }
    # Archives from earlier releases may have been pruned locally; only
    # entries whose file is still present can be re-verified.
    FILE="$ARCHIVES/$(basename "$url")"
    [ -f "$FILE" ] || continue
    swift "$ROOT/scripts/release/eddsa.swift" verify "$NITPICK_ED_PUBLIC_KEY" "$FILE" "$sig" || {
        echo "appcast.sh: $(basename "$FILE") signature does not verify against NITPICK_ED_PUBLIC_KEY — generate_appcast signed with a different private key" >&2
        exit 1; }
    : > "$WORK/verified"
done || exit 1
[ -f "$WORK/verified" ] || {
    echo "appcast.sh: no enclosure could be verified — no archive files present?" >&2; exit 1; }
echo "appcast.sh: wrote $APPCAST"
