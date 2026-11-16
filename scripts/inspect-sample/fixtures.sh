#!/bin/sh
# Rebuilds Acme Store and the Inspect library the way the server builds it,
# runs each of the app's screens on the given simulator with the library
# loaded, and keeps the library's answers, gzipped, as the fixtures
# server/test/LayoutSnapshot.test.ts reads. Needs Xcode and a simulator; the
# tests need neither. Boots the simulator if it isn't, and leaves it booted.
# Names after the UDID record only those screens.
#
#   scripts/inspect-sample/fixtures.sh <simulator UDID> [screen…]
set -eu
cd "$(dirname "$0")/../.."
udid=$1
shift
screens=${*:-shop scrolled browse sheet cover picks}
bundle=dev.nitpick.fixture.acmestore
build=scripts/inspect-sample/.build
fixtures=server/test/fixtures/layout

mkdir -p "$build/AcmeStore.app" "$fixtures"
cp scripts/inspect-sample/Info.plist "$build/AcmeStore.app/"
xcrun --sdk iphonesimulator swiftc -target arm64-apple-ios18.0-simulator \
    -parse-as-library -o "$build/AcmeStore.app/AcmeStore" \
    scripts/inspect-sample/AcmeStore.swift

library=$(node --input-type=module -e '
    import { buildInspectLibrary } from "./server/src/device/inspect.ts"
    import { nodeSubprocessRunner } from "./server/src/subprocess.ts"
    const built = await buildInspectLibrary(nodeSubprocessRunner, process.argv[1])
    if (built.status !== "built") process.exit(1)
    console.log(built.path)
' "$PWD/$build/inspect")
port=$(node -e '
    const server = require("node:net").createServer()
    server.listen(0, "127.0.0.1", () => {
        console.log(server.address().port)
        server.close()
    })
')
secret=$(openssl rand -hex 32)

xcrun simctl boot "$udid" 2>/dev/null || true
xcrun simctl bootstatus "$udid" -b >/dev/null
xcrun simctl install "$udid" "$build/AcmeStore.app"
for screen in $screens; do
    SIMCTL_CHILD_DYLD_INSERT_LIBRARIES="$library" \
    SIMCTL_CHILD_NITPICK_INSPECT_PORT="$port" \
    SIMCTL_CHILD_NITPICK_INSPECT_SECRET="$secret" \
    SIMCTL_CHILD_ACME_SCREEN="$screen" \
        xcrun simctl launch --terminate-running-process "$udid" "$bundle" >/dev/null
    # Long enough for the first frame and for a sheet to finish presenting.
    sleep 5
    curl -sf -H "Authorization: Bearer $secret" -o "$build/$screen.json" \
        "http://127.0.0.1:$port/layout"
    gzip -9nc "$build/$screen.json" >"$fixtures/$screen.json.gz"
    echo "$fixtures/$screen.json.gz"
done
xcrun simctl terminate "$udid" "$bundle"
