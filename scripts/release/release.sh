#!/bin/sh
# Compatibility wrapper. The release ladder now lives in the top-level
# Makefile (`make release`); this script forwards to it so existing callers
# and muscle memory keep working. Prefer `make release VERSION=… BUILD=…`.
#
# Usage: release.sh <version> <build>     e.g. release.sh 1.0.1 2
#   <version>  marketing version (CFBundleShortVersionString)
#   <build>    monotonically increasing integer (CFBundleVersion) —
#              Sparkle compares THIS to decide what is an update
set -eu
[ $# -eq 2 ] || { echo "usage: release.sh <version> <build>" >&2; exit 2; }
cd "$(dirname "$0")/../.."
exec make release VERSION="$1" BUILD="$2"
