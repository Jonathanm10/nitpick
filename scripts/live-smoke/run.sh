#!/bin/sh
# Builds a minimal real simulator app, zips it the way CI does, and runs the
# gated live smoke test (LiveSmokeTests) against live simctl.
set -eu
cd "$(dirname "$0")"

xcrun -sdk iphonesimulator swiftc \
    -target arm64-apple-ios17.0-simulator \
    -o SmokeApp.app/SmokeApp main.swift
ditto -c -k --keepParent SmokeApp.app SmokeApp.zip

cd ../..
NITPICK_LIVE_SMOKE=1 \
NITPICK_SMOKE_ZIP="$PWD/scripts/live-smoke/SmokeApp.zip" \
    swift test --filter LiveSmokeTests
