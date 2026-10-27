#!/bin/sh
# One-shot release, run by the T3 Code "Release" action as `make ship`: works
# out the next version and build, runs the signed + notarized ladder (`make
# release`), publishes the zip + appcast on the `updates` release so installed
# copies update through Sparkle (`make publish`), and cuts the versioned
# GitHub release vX.Y.Z with notes.
#
# Nothing leaves the machine until the ladder has passed, so Ctrl-C during the
# build or notarization aborts cleanly.
#
# VERSION bumps the latest vX.Y.Z tag: minor when a commit since it is a feat,
# patch otherwise. BUILD is the published appcast's highest build + 1, so a
# build number an aborted run used locally but never published is reused.
#
# Overrides (environment):
#   NITPICK_BUMP=major|minor|patch   force the bump
#   NITPICK_VERSION=X.Y.Z            force the version
#   NITPICK_NOTES_FILE=<markdown>    use these notes instead of drafting them
#   NITPICK_SHIP_DRY_RUN=1           preflight, plan and notes only; preflight
#                                    failures are reported instead of fatal
#
# Usage: ship.sh
set -eu
cd "$(dirname "$0")/../.."
ROOT="$PWD"
. "$ROOT/scripts/release/release.env"

DRY_RUN="${NITPICK_SHIP_DRY_RUN:-}"
say() { printf '\n==> %s\n' "$*"; }
die() { echo "ship.sh: $*" >&2; exit 1; }
# A failed precondition stops a real run; a dry run reports it and goes on.
require() {
    if [ -n "$DRY_RUN" ]; then echo "ship.sh: would stop: $*" >&2; else die "$*"; fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- preflight -------------------------------------------------------------
say 'Preflight'
gh auth status >/dev/null 2>&1 || die 'gh is not logged in — run gh auth login'
ON_MAIN=''
CLEAN=''
[ "$(git symbolic-ref --short -q HEAD || true)" = main ] && ON_MAIN=1
[ -z "$(git status --porcelain)" ] && CLEAN=1
[ -n "$ON_MAIN" ] || require 'not on branch main'
[ -n "$CLEAN" ] || require 'working tree is not clean'
git fetch --quiet --tags origin main
SHORT="$(git rev-parse --short HEAD)"
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
    # A clean main that is only behind fast-forwards, then restarts so the
    # rest runs on the updated scripts.
    if [ -n "$ON_MAIN" ] && [ -n "$CLEAN" ] && git merge-base --is-ancestor HEAD origin/main; then
        if [ -n "$DRY_RUN" ]; then
            echo "ship.sh: would fast-forward main from $SHORT to origin/main; planning from origin/main"
        else
            git merge --ff-only --quiet origin/main
            echo "ship.sh: fast-forwarded main from $SHORT to $(git rev-parse --short HEAD); restarting"
            exec "$ROOT/scripts/release/ship.sh"
        fi
    else
        require "HEAD $SHORT is not origin/main and cannot fast-forward to it"
    fi
fi
# A dry run plans what a real run would ship: origin/main.
SHA="$(git rev-parse origin/main)"
SHORT="$(git rev-parse --short "$SHA")"

CI="$(gh run list --commit "$SHA" --workflow ci.yml --limit 1 \
    --json status,conclusion --jq '.[0] | if . == null then "missing" else "\(.status)/\(.conclusion)" end')"
[ "$CI" = completed/success ] || require "Swift checks on $SHORT is $CI, not completed/success"

LAST_TAG="$(git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -n 1)"
[ -n "$LAST_TAG" ] || die 'no vX.Y.Z tag to bump from'
COMMITS="$(git rev-list --count --no-merges "$LAST_TAG..$SHA")"
[ "$COMMITS" -gt 0 ] || require "nothing to release — $SHORT is $LAST_TAG"

# --- version and build -----------------------------------------------------
if [ -n "${NITPICK_VERSION:-}" ]; then
    VERSION="$NITPICK_VERSION"
    BUMP=override
else
    BUMP="${NITPICK_BUMP:-}"
    if [ -z "$BUMP" ]; then
        if git log --no-merges --format=%s "$LAST_TAG..$SHA" | grep -Eq '^feat(\([^)]*\))?!?:'; then
            BUMP='minor'
        else
            BUMP='patch'
        fi
    fi
    IFS=. read -r MAJOR MINOR PATCH <<EOF
${LAST_TAG#v}
EOF
    case "$BUMP" in
        major) VERSION="$((MAJOR + 1)).0.0" ;;
        minor) VERSION="$MAJOR.$((MINOR + 1)).0" ;;
        patch) VERSION="$MAJOR.$MINOR.$((PATCH + 1))" ;;
        *) die "NITPICK_BUMP must be major, minor or patch, not $BUMP" ;;
    esac
fi
TAG="v$VERSION"
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then die "$TAG already exists"; fi

# The published feed is the truth for build numbers: a local appcast can carry
# an entry an aborted run never uploaded.
gh release download updates --pattern appcast.xml --dir "$WORK"
LAST_BUILD="$(sed -n 's|.*<sparkle:version>\([0-9]*\)</sparkle:version>.*|\1|p' "$WORK/appcast.xml" \
    | sort -n | tail -n 1)"
[ -n "$LAST_BUILD" ] || die 'the published appcast lists no build numbers'
BUILD=$((LAST_BUILD + 1))
ZIP="dist/releases/Nitpick-$VERSION-$BUILD.zip"

say "Plan: nitpick $VERSION (build $BUILD) from $SHORT — $LAST_TAG + $COMMITS commits, $BUMP bump"

# --- release notes ---------------------------------------------------------
NOTES="dist/notes-$TAG.md"
mkdir -p dist
PRS="$(git log --merges --format=%s "$LAST_TAG..$SHA" \
    | sed -n 's/^Merge pull request #\([0-9]*\) .*/\1/p' | sort -n)"

if [ -n "${NITPICK_NOTES_FILE:-}" ]; then
    cp "$NITPICK_NOTES_FILE" "$WORK/body.md"
else
    say 'Drafting release notes'
    git log --no-merges --format='- %s' "$LAST_TAG..$SHA" > "$WORK/commits.txt"
    if command -v claude >/dev/null 2>&1 &&
        claude -p --safe-mode --tools "" --no-session-persistence \
            "These are the commit subjects merged since nitpick $LAST_TAG. nitpick is a macOS app for reviewing iOS builds in the Simulator and filing the findings as YouTrack issues. Write the release notes for nitpick $VERSION for its users. Output only Markdown: a '## What's new' section and/or a '## What's fixed' section, one bullet per user-visible change, plain language, no commit hashes, no type prefixes. Merge commits about the same change into one bullet. Leave out refactors, tests, CI, docs and snapshot tooling. If nothing is user-visible, output '## What's changed' with the single bullet '- Internal improvements.'" \
            < "$WORK/commits.txt" > "$WORK/body.md" 2>"$WORK/claude.err" &&
        grep -q '^## ' "$WORK/body.md"; then
        :
    else
        echo 'ship.sh: claude could not draft the notes; listing merged pull requests instead' >&2
        printf "## What's changed\n\n" > "$WORK/body.md"
        if [ -z "$PRS" ]; then cat "$WORK/commits.txt" >> "$WORK/body.md"; fi
        for pr in $PRS; do
            printf -- '- %s (#%s)\n' "$(gh pr view "$pr" --json title --jq .title)" "$pr" >> "$WORK/body.md"
        done
    fi
fi

INCLUDES=''
[ -z "$PRS" ] || INCLUDES=" (includes $(printf '#%s, ' $PRS | sed 's/, $//'))"
{
    cat "$WORK/body.md"
    printf '\nBuilt from `main` @ %s%s.\n\n' "$SHORT" "$INCLUDES"
    printf 'Sparkle auto-update: build **%s**. Existing installs pick this up via Check for Updates.\n' "$BUILD"
} > "$NOTES"
cat "$NOTES"

if [ -n "$DRY_RUN" ]; then
    say "Dry run: stopping before the build. Notes are in $NOTES"
    exit 0
fi

# --- mirror the published feed into dist/releases --------------------------
# generate_appcast extends dist/releases/appcast.xml with every zip in the
# directory, so the directory must hold exactly what is published: the live
# appcast, the published zips, and the new one. A local zip that was never
# uploaded (or differs from the upload) would ship an enclosure that 404s or
# fails its signature check, so it moves to dist/unpublished/.
say 'Syncing dist/releases with the published feed'
mkdir -p dist/releases
cp "$WORK/appcast.xml" dist/releases/appcast.xml
gh release view updates --json assets --jq '.assets[] | "\(.digest) \(.name)"' > "$WORK/assets.txt"
for zip in dist/releases/*.zip; do
    [ -e "$zip" ] || continue
    name="$(basename "$zip")"
    grep -Fqx "sha256:$(shasum -a 256 "$zip" | cut -d' ' -f1) $name" "$WORK/assets.txt" && continue
    mkdir -p dist/unpublished
    mv "$zip" dist/unpublished/
    echo "moved $name to dist/unpublished/ — it is not on the updates release"
done
sed -n 's|.*<enclosure url="[^"]*/\([^"/]*\.zip\)".*|\1|p' dist/releases/appcast.xml > "$WORK/enclosures.txt"
while IFS= read -r name; do
    [ -e "dist/releases/$name" ] || gh release download updates --pattern "$name" --dir dist/releases
done < "$WORK/enclosures.txt"

# --- build, sign, notarize -------------------------------------------------
say "Building, signing and notarizing $VERSION ($BUILD)"
make release VERSION="$VERSION" BUILD="$BUILD"

# --- publish ---------------------------------------------------------------
# The versioned release starts as a draft so its tag only appears once the
# Sparkle feed is live. A draft left by an aborted run would block the name.
say "Publishing $TAG"
if [ "$(gh release view "$TAG" --json isDraft --jq .isDraft 2>/dev/null || true)" = true ]; then
    gh release delete "$TAG" --yes
fi
gh release create "$TAG" "$ZIP" --draft --target "$SHA" \
    --title "nitpick $VERSION" --notes-file "$NOTES"
make publish VERSION="$VERSION" BUILD="$BUILD"
gh release edit "$TAG" --draft=false --latest ||
    die "build $BUILD is live for Sparkle users but $TAG is still a draft — finish with: gh release edit $TAG --draft=false --latest"
git fetch --quiet --tags origin

# --- verify what users will fetch -----------------------------------------
say 'Verifying the live feed'
ok=''
for _ in 1 2 3 4 5; do
    if curl -fsSL "$NITPICK_FEED_URL" | grep -q "<sparkle:version>$BUILD</sparkle:version>" &&
        curl -fsIL -o /dev/null "${NITPICK_DOWNLOAD_URL_PREFIX%/}/Nitpick-$VERSION-$BUILD.zip"; then
        ok=1
        break
    fi
    sleep 5
done
[ -n "$ok" ] || die "the live appcast or Nitpick-$VERSION-$BUILD.zip does not resolve yet — check $NITPICK_FEED_URL"

say "Released nitpick $VERSION (build $BUILD): $(gh release view "$TAG" --json url --jq .url)"
