#!/bin/sh
# Installs or updates nitpick on its Device Host over SSH (docs/operations.md):
# streams host.sh there and runs its update, which checks out the public
# repo's ref, installs the pinned Node and the dependencies, builds the web
# app, restarts the server and checks it answers. The host needs Xcode and
# the account logged in at its console; nothing about it lives in the repo.
#
#   scripts/deploy/deploy.sh <ssh destination> [ref]
#   NITPICK_DEPLOY_HOST=<ssh destination> scripts/deploy/deploy.sh [ref]
#
# ref is a branch, tag or commit of origin; main by default. Pass an earlier
# commit to roll back. NITPICK_DEPLOY_SSH is the ssh command with any options
# (default: ssh), e.g. NITPICK_DEPLOY_SSH="ssh -i ~/.ssh/<key>".
set -eu

here=$(cd "$(dirname "$0")" && pwd)
if [ -n "${NITPICK_DEPLOY_HOST:-}" ]; then
	destination=$NITPICK_DEPLOY_HOST
else
	[ $# -ge 1 ] || {
		echo "usage: deploy.sh <ssh destination> [ref]" >&2
		exit 64
	}
	destination=$1
	shift
fi
ref=${1:-main}
case $ref in '' | *[!A-Za-z0-9._/-]*)
	echo "deploy.sh: not a git ref: $ref" >&2
	exit 64
	;;
esac

# shellcheck disable=SC2086 # NITPICK_DEPLOY_SSH is a command and its options.
exec ${NITPICK_DEPLOY_SSH:-ssh} "$destination" "/bin/sh -s -- update $ref" <"$here/host.sh"
