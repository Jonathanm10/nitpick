#!/bin/sh
# Builds the release binary and assembles dist/Nitpick.app — a real bundle
# with Info.plist, PkgInfo, and Sparkle.framework embedded. `swift run` stays
# the dev flow; this is the shipping flow.
#
# Usage: bundle.sh --version 1.0.0 --build 1 [--universal] [--output dir]
# Feed URL and EdDSA public key come from release.env (env overrides win).
set -eu
cd "$(dirname "$0")/../.."
ROOT="$PWD"
. "$ROOT/scripts/release/release.env"

VERSION="" BUILD="" UNIVERSAL=0 OUTPUT="$ROOT/dist"
while [ $# -gt 0 ]; do
    case "$1" in
        --version) VERSION="$2"; shift 2 ;;
        --build) BUILD="$2"; shift 2 ;;
        --universal) UNIVERSAL=1; shift ;;
        --output) OUTPUT="$2"; shift 2 ;;
        *) echo "bundle.sh: unknown argument $1" >&2; exit 2 ;;
    esac
done
[ -n "$VERSION" ] && [ -n "$BUILD" ] || {
    echo "bundle.sh: --version and --build are required" >&2; exit 2; }
[ -n "$NITPICK_FEED_URL" ] || {
    echo "bundle.sh: NITPICK_FEED_URL is empty — set it in scripts/release/release.env" >&2; exit 2; }
[ -n "$NITPICK_ED_PUBLIC_KEY" ] || {
    echo "bundle.sh: NITPICK_ED_PUBLIC_KEY is empty — set it in scripts/release/release.env" >&2; exit 2; }
# Sparkle rejects a malformed key only at runtime; fail here instead.
KEY_BYTES="$(printf %s "$NITPICK_ED_PUBLIC_KEY" | base64 -d 2>/dev/null | wc -c | tr -d ' ')"
[ "$KEY_BYTES" = 32 ] || {
    echo "bundle.sh: NITPICK_ED_PUBLIC_KEY must be the base64 of a 32-byte ed25519 public key (got $KEY_BYTES bytes)" >&2; exit 2; }

# Build. Universal for shipping; single-arch for local drills.
if [ "$UNIVERSAL" = 1 ]; then
    ARCH_FLAGS="--arch arm64 --arch x86_64"
else
    ARCH_FLAGS=""
fi
# shellcheck disable=SC2086 # ARCH_FLAGS is deliberately word-split
swift build -c release --product Nitpick $ARCH_FLAGS
# shellcheck disable=SC2086
BIN_DIR="$(swift build -c release --product Nitpick $ARCH_FLAGS --show-bin-path)"

FRAMEWORK="$ROOT/.build/artifacts/sparkle/Sparkle/Sparkle.xcframework/macos-arm64_x86_64/Sparkle.framework"
[ -d "$FRAMEWORK" ] || {
    echo "bundle.sh: Sparkle.framework not found under .build/artifacts — run swift package resolve" >&2; exit 1; }

# Assemble the bundle.
APP="$OUTPUT/Nitpick.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Frameworks" "$APP/Contents/Resources"
cp "$BIN_DIR/Nitpick" "$APP/Contents/MacOS/Nitpick"
cp -R "$FRAMEWORK" "$APP/Contents/Frameworks/Sparkle.framework"
printf 'APPL????' > "$APP/Contents/PkgInfo"

PLIST="$APP/Contents/Info.plist"
cp "$ROOT/scripts/release/Info.plist.template" "$PLIST"
/usr/libexec/PlistBuddy \
    -c "Set :CFBundleShortVersionString $VERSION" \
    -c "Set :CFBundleVersion $BUILD" \
    -c "Set :SUFeedURL $NITPICK_FEED_URL" \
    -c "Set :SUPublicEDKey $NITPICK_ED_PUBLIC_KEY" \
    "$PLIST"

# The SwiftPM binary references @rpath/Sparkle.framework…; point @rpath at
# the embedded copy and drop the build-machine paths SwiftPM baked in.
EXECUTABLE="$APP/Contents/MacOS/Nitpick"
install_name_tool -add_rpath "@executable_path/../Frameworks" "$EXECUTABLE"
# sort -u: universal binaries list each LC_RPATH once per architecture,
# but delete_rpath strips all slices at once — a second pass would abort.
otool -l "$EXECUTABLE" | awk '/LC_RPATH/ { getline; getline; print $2 }' | sort -u |
while IFS= read -r rpath; do
    case "$rpath" in
        @*|/usr/lib*) ;; # keep relative and system runtime paths
        *) install_name_tool -delete_rpath "$rpath" "$EXECUTABLE" ;;
    esac
done

echo "bundle.sh: assembled $APP ($VERSION build $BUILD)"
