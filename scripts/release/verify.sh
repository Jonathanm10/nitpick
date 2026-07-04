#!/bin/sh
# Verifies a built bundle before it leaves the machine. Two tiers:
#
#   verify.sh [app-path]              structural + signature checks — valid on
#                                     any signed bundle, including ad-hoc
#   verify.sh --notarized [app-path]  adds the Gatekeeper assessment and
#                                     staple check — only a Developer ID
#                                     signed, notarized, stapled bundle passes
#   verify.sh --launch …              adds a launch smoke test: the app must
#                                     start and still be running 5s later
#
# Gatekeeper is deliberately NOT part of the base tier: an ad-hoc dev bundle
# always fails spctl, and a green checkmark there would prove nothing about
# the notarized artifact.
set -eu
cd "$(dirname "$0")/../.."
ROOT="$PWD"

APP="$ROOT/dist/Nitpick.app" NOTARIZED=0 LAUNCH=0
while [ $# -gt 0 ]; do
    case "$1" in
        --notarized) NOTARIZED=1; shift ;;
        --launch) LAUNCH=1; shift ;;
        *) APP="$1"; shift ;;
    esac
done
[ -d "$APP" ] || { echo "verify.sh: no bundle at $APP" >&2; exit 2; }
EXECUTABLE="$APP/Contents/MacOS/Nitpick"
fail() { echo "verify.sh: FAIL — $1" >&2; exit 1; }

# 1. Signature: whole bundle, nested code included.
codesign --verify --deep --strict "$APP" || fail "codesign verification"

# 2. No sandbox on the app — sandboxing would break simctl spawning and
#    Build ingestion (issue 11 acceptance criterion). Sparkle's nested
#    Downloader.xpc keeps its own sandbox; only the app's entitlements count.
if codesign -d --entitlements - --xml "$APP" 2>/dev/null |
        grep -q 'com.apple.security.app-sandbox'; then
    fail "the app declares com.apple.security.app-sandbox"
fi

# 3. Info.plist carries what Sparkle and the OS need.
for key in CFBundleIdentifier CFBundleShortVersionString CFBundleVersion \
        LSMinimumSystemVersion SUFeedURL SUPublicEDKey; do
    value="$(/usr/libexec/PlistBuddy -c "Print :$key" "$APP/Contents/Info.plist" 2>/dev/null)" \
        || fail "Info.plist is missing $key"
    [ -n "$value" ] || fail "Info.plist has an empty $key"
done

# 4. Sparkle is embedded and findable: @rpath linkage, an rpath that points
#    into the bundle, no build-machine paths left behind.
otool -L "$EXECUTABLE" | grep -q '@rpath/Sparkle.framework' \
    || fail "executable does not link Sparkle via @rpath"
[ -e "$APP/Contents/Frameworks/Sparkle.framework/Versions/B/Sparkle" ] \
    || fail "Sparkle.framework is not embedded"
RPATHS="$(otool -l "$EXECUTABLE" | awk '/LC_RPATH/ { getline; getline; print $2 }')"
echo "$RPATHS" | grep -q '@executable_path/../Frameworks' \
    || fail "missing @executable_path/../Frameworks rpath"
echo "$RPATHS" | grep -v '^@' | grep -v '^/usr/lib' | grep -q . \
    && fail "build-machine rpath left in executable: $(echo "$RPATHS" | grep -v '^@' | grep -v '^/usr/lib')"

# 5. Notarization tier: Gatekeeper assessment + stapled ticket.
if [ "$NOTARIZED" = 1 ]; then
    spctl --assess --type execute "$APP" || fail "Gatekeeper assessment (spctl)"
    xcrun stapler validate "$APP" || fail "staple validation"
fi

# 6. Launch smoke: the bundle must start as a real app and stay up.
if [ "$LAUNCH" = 1 ]; then
    open "$APP"
    sleep 5
    PID="$(pgrep -f "$EXECUTABLE" | head -1)"
    [ -n "$PID" ] || fail "app not running 5s after launch"
    kill "$PID"
    echo "verify.sh: launch smoke OK (pid $PID)"
fi

echo "verify.sh: OK — $APP"
