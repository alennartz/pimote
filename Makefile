.PHONY: all install build patch-dependencies build-shared build-sdk build-server build-client package version \
        dev dev-server dev-client \
        start test clean help \
        format format-check lint check \
        android-image android-build android-test android-connect android-install android-shell \
        android-gradle android-clean android-tooling-test

# ── Config ────────────────────────────────────────────────────────────────────

# Optional machine-local overrides live in Makefile.local (gitignored).
-include Makefile.local

# PORT is optional — if not set, the server uses the value from the Pimote config.
# Override with: make start PORT=3001

ARTIFACTS_DIR ?= .artifacts

# ── Default ───────────────────────────────────────────────────────────────────

all: build

# ── Install ───────────────────────────────────────────────────────────────────

install:
	npm install

# ── Build ─────────────────────────────────────────────────────────────────────

## Apply dependency patches before compiling or bundling any workspace
patch-dependencies:
	npm run patch:dependencies

## Build everything in dependency order: shared → SDK → server, then client
build: patch-dependencies build-sdk build-shared build-server build-client

build-shared: patch-dependencies
	npm run build:shared

build-sdk: patch-dependencies
	npm run build --workspace=@pimote/sdk

## Server depends on shared and SDK; rebuild both first if you've changed them
build-server: patch-dependencies build-shared build-sdk
	npm run build --workspace=@pimote/server

build-client: patch-dependencies
	npm run build --workspace=client

## Create a publishable tarball in $(ARTIFACTS_DIR)
package: build
	mkdir -p $(ARTIFACTS_DIR)
	npm pack --ignore-scripts --pack-destination $(ARTIFACTS_DIR)

## Bump the release version everywhere (root, server, client, SDK, lockfile).
## Requires VERSION, e.g.: make version VERSION=0.17.0
version:
	npm version $(VERSION) --no-git-tag-version

# ── Dev (hot-reload) ──────────────────────────────────────────────────────────

## Run server and client dev servers concurrently (requires tmux or two terminals).
## Use make dev-server and make dev-client in separate terminals instead.
dev:
	@echo "Run these in two separate terminals:"
	@echo "  make dev-server"
	@echo "  make dev-client"

dev-server:
	npm run dev --workspace=@pimote/server

## Vite dev server — proxies /ws to localhost:$(PORT)
dev-client:
	npm run dev --workspace=client

# ── Production start ──────────────────────────────────────────────────────────

## Run the production app from the repo checkout.
## Port comes from ~/.config/pimote/config.json unless PORT= is passed explicitly.
start:
	node ./bin/pimote.js start $(if $(PORT),--port $(PORT),)

# ── Lint & Format ─────────────────────────────────────────────────────────────

## Format all files with Prettier
format:
	npm run format

## Check formatting without writing
format-check:
	npm run format:check

## Run ESLint on all files
lint:
	npm run lint

## Run type checking (svelte-check + tsc)
check:
	npm run check

# ── Test ──────────────────────────────────────────────────────────────────────

test: patch-dependencies
	npm run test --workspace=@pimote/server -- --run
	npm run test --workspace=client -- --run
	npm run test:patches

# ── Clean ─────────────────────────────────────────────────────────────────────

clean:
	rm -rf shared/dist
	rm -rf shared/tsconfig.tsbuildinfo
	rm -rf server/dist
	rm -rf server/tsconfig.tsbuildinfo
	rm -rf client/.svelte-kit
	rm -rf client/build
	rm -rf $(ARTIFACTS_DIR)

# ── Android client (mobile/android) ───────────────────────────────────────────

ANDROID_TOOLS := mobile/android/tools
ANDROID_IMAGE ?= pimote-android-builder:local
export ANDROID_IMAGE

android-image:
	$(ANDROID_TOOLS)/android-image

android-build:
	$(ANDROID_TOOLS)/android-build

android-test:
	$(ANDROID_TOOLS)/run-container -- ./gradlew test

android-connect:
	$(ANDROID_TOOLS)/android-connect

android-install:
	$(ANDROID_TOOLS)/android-install

android-shell:
	$(ANDROID_TOOLS)/run-container --interactive -- bash

android-gradle:
	$(ANDROID_TOOLS)/run-container -- ./gradlew $(ARGS)

android-clean:
	$(ANDROID_TOOLS)/run-container -- ./gradlew clean

android-tooling-test:
	bash mobile/android/tests/discovery.test.sh

# ── Help ──────────────────────────────────────────────────────────────────────

help:
	@echo ""
	@echo "Usage: make [target] [PORT=3000]"
	@echo ""
	@echo "  install          Install all workspace dependencies"
	@echo "  build            Apply patches, then build shared → server → client (production)"
	@echo "  patch-dependencies Apply checked-in dependency patches"
	@echo "  build-shared     Build shared types/utils only"
	@echo "  build-server     Build server only (rebuilds shared first)"
	@echo "  build-client     Build client only"
	@echo "  package          Create a publishable npm tarball in $(ARTIFACTS_DIR)"
	@echo ""
	@echo "  dev-server       Run server with hot-reload (tsx watch)"
	@echo "  dev-client       Run Vite dev server (proxies /ws to :PORT)"
	@echo ""
	@echo "  start            Start the repo build via the pimote CLI"
	@echo "  test             Run all tests (server + client, single run)"
	@echo ""
	@echo "  format           Format all files with Prettier (writes changes)"
	@echo "  format-check     Check formatting without writing"
	@echo "  lint             Run ESLint on all files"
	@echo "  check            Run type checking (svelte-check + tsc)"
	@echo ""
	@echo "  clean            Remove all build artifacts"
	@echo ""
	@echo "  deployment       Copy Makefile.local.example for local deployment targets"
	@echo ""
	@echo "  android-image    Build the Android build container image ($(ANDROID_IMAGE))"
	@echo "  android-build    Assemble the debug APK inside the build container"
	@echo "  android-test     Run Android unit tests inside the build container"
	@echo "  android-connect  Connect and verify the wireless debugging phone"
	@echo "  android-install  Build the debug APK and install it on the phone"
	@echo "  android-shell    Interactive bash shell inside the build container"
	@echo "  android-gradle   Run an arbitrary gradle task: make android-gradle ARGS=\"<task>\""
	@echo "  android-clean    gradle clean inside the build container"
	@echo "  android-tooling-test  Test host device selection (no Docker or phone)"
	@echo ""
	@echo "  help             Show this message"
	@echo ""

