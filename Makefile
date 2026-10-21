.PHONY: all install build build-shared build-sdk build-server build-client package \
        dev dev-server dev-client \
        start test clean help \
        format format-check lint check \
        android-image android-build android-test android-shell android-gradle android-clean

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

## Build everything in dependency order: shared → SDK → server, then client
build: build-shared build-sdk build-server build-client

build-shared:
	npm run build:shared

build-sdk:
	npm run build --workspace=@pimote/sdk

## Server depends on shared and SDK; rebuild both first if you've changed them
build-server: build-shared build-sdk
	npm run build --workspace=@pimote/server

build-client:
	npm run build --workspace=client

## Create a publishable tarball in $(ARTIFACTS_DIR)
package: build
	mkdir -p $(ARTIFACTS_DIR)
	npm pack --ignore-scripts --pack-destination $(ARTIFACTS_DIR)

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

test:
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

ANDROID_DIR := mobile/android
ANDROID_IMAGE ?= pimote-android-builder:local
ANDROID_DOCKER_RUN := docker run --rm -t \
	-v $(CURDIR)/$(ANDROID_DIR):/workspace \
	-w /workspace \
	-u $(shell id -u):$(shell id -g) \
	-e HOME=/workspace/.docker-home \
	$(ANDROID_IMAGE)

android-image:
	docker build -f $(ANDROID_DIR)/build.Dockerfile -t $(ANDROID_IMAGE) $(ANDROID_DIR)

android-build:
	$(ANDROID_DOCKER_RUN) ./gradlew assembleDebug

android-test:
	$(ANDROID_DOCKER_RUN) ./gradlew test

android-shell:
	docker run --rm -it \
		-v $(CURDIR)/$(ANDROID_DIR):/workspace \
		-w /workspace \
		-u $(shell id -u):$(shell id -g) \
		-e HOME=/workspace/.docker-home \
		$(ANDROID_IMAGE) bash

android-gradle:
	$(ANDROID_DOCKER_RUN) ./gradlew $(ARGS)

android-clean:
	$(ANDROID_DOCKER_RUN) ./gradlew clean

# ── Help ──────────────────────────────────────────────────────────────────────

help:
	@echo ""
	@echo "Usage: make [target] [PORT=3000]"
	@echo ""
	@echo "  install          Install all workspace dependencies"
	@echo "  build            Build shared → server → client (production)"
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
	@echo "  android-shell    Interactive bash shell inside the build container"
	@echo "  android-gradle   Run an arbitrary gradle task: make android-gradle ARGS=\"<task>\""
	@echo "  android-clean    gradle clean inside the build container"
	@echo ""
	@echo "  help             Show this message"
	@echo ""

