# nitpick — dev and release tasks. The full pipeline is documented in
# docs/release.md; this Makefile is its single entry point. The per-stage
# scripts under scripts/release/ hold the load-bearing platform knowledge
# (rpath fixing, inside-out signing, EdDSA verification); the Makefile just
# orders them and lets each stage run on its own.
#
#   make run                          swift run — the dev flow
#   make test
#   make release VERSION=1.1.0 BUILD=3   full signed + notarized ladder
#   make publish VERSION=1.1.0 BUILD=3   upload the zip + appcast to GitHub
#   make bundle|sign|verify|notarize|package|appcast   individual stages
#   make drill                        local Sparkle vN->vN+1 update drill
#   make setup                        one-time signing/hosting wizard
#
# VERSION is the marketing version; BUILD is a monotonically increasing
# integer — Sparkle compares BUILD to decide what counts as an update, so
# never reuse or decrease one.

SHELL := /bin/sh
REL   := scripts/release
APP   := dist/Nitpick.app
ZIP    = dist/releases/Nitpick-$(VERSION)-$(BUILD).zip

# The release stages are a strict ladder (build -> sign -> verify -> notarize
# -> staple -> package -> appcast); never run them in parallel.
.NOTPARALLEL:
.PHONY: help run test icon bundle sign verify notarize verify-release package \
        appcast release publish drill setup clean require-version

help:
	@echo 'nitpick make targets:'
	@echo '  run                        swift run (dev flow)'
	@echo '  test                       swift test'
	@echo '  icon                       regenerate assets/AppIcon.icns from assets/icon.svg'
	@echo '  release VERSION= BUILD=    full signed + notarized release ladder'
	@echo '  publish VERSION= BUILD=    upload the release zip + appcast to GitHub'
	@echo '  bundle|sign|verify|notarize|package|appcast   individual stages'
	@echo '  drill                      local Sparkle update drill (no Apple account)'
	@echo '  setup                      one-time signing/hosting wizard'
	@echo '  clean                      remove dist/Nitpick.app and dist/drill'
	@echo
	@echo 'e.g. make release VERSION=1.1.0 BUILD=3'

run:
	swift run Nitpick

test:
	swift test

# Regenerate assets/AppIcon.icns from assets/icon.svg. The .icns is committed
# so the release ladder never renders; rerun this only when the artwork changes.
icon:
	swift scripts/make-icon.swift

# --- release ladder --------------------------------------------------------
# Each stage is runnable on its own; `release` chains them in ladder order.

bundle: require-version
	$(REL)/bundle.sh --version $(VERSION) --build $(BUILD) --universal

sign:
	$(REL)/sign.sh

verify:
	$(REL)/verify.sh

notarize:
	$(REL)/notarize.sh

verify-release:
	$(REL)/verify.sh --notarized --launch

# Package the STAPLED app — the zip is both the direct download and Sparkle's
# update enclosure, so it must be built after notarize/staple. The build
# number is in the name so a build-only re-release can't overwrite a zip an
# existing appcast entry still points at. --norsrc --noextattr --noqtn ships
# no AppleDouble (._*) metadata; verify.sh --zip re-extracts with CLI unzip
# and fails the release if any ever reappears (it would break the seal).
package: require-version
	@mkdir -p dist/releases
	rm -f "$(ZIP)"
	ditto -c -k --keepParent --norsrc --noextattr --noqtn "$(APP)" "$(ZIP)"
	$(REL)/verify.sh --zip "$(ZIP)"

# generate_appcast extends the existing appcast and keeps prior entries, so
# dist/releases/ must survive between releases (clean does not touch it).
appcast:
	$(REL)/appcast.sh dist/releases

release: bundle sign verify notarize verify-release package appcast
	@echo
	@echo 'make release: done. Publish so the enclosure URLs resolve:'
	@echo '  make publish VERSION=$(VERSION) BUILD=$(BUILD)'

# --- publish ---------------------------------------------------------------
# Uploads to the fixed `updates` release whose enclosure URLs stay stable
# across versions. gh infers the repo from the origin remote.
publish: require-version
	gh release upload updates "$(ZIP)" dist/releases/appcast.xml --clobber

# --- local QA / setup ------------------------------------------------------
drill:
	$(REL)/update-drill.sh

setup:
	$(REL)/setup-signing.sh

# Transient build outputs only — dist/releases/ is deliberately kept so the
# appcast can extend across releases.
clean:
	rm -rf "$(APP)" dist/drill

# --- guards ----------------------------------------------------------------
require-version:
	@[ -n "$(VERSION)" ] || { echo 'set VERSION= (e.g. make release VERSION=1.1.0 BUILD=3)' >&2; exit 2; }
	@[ -n "$(BUILD)" ]   || { echo 'set BUILD= (monotonic integer; Sparkle compares it)' >&2; exit 2; }
