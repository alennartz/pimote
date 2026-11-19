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

install: ## Install workspace dependencies
	npm install

# ── Build ─────────────────────────────────────────────────────────────────────

patch-dependencies: ## Apply checked-in dependency patches
	npm run patch:dependencies

build: patch-dependencies build-sdk build-shared build-server build-client ## Build shared, SDK, server, then client

build-shared: patch-dependencies ## Build shared types only
	npm run build:shared

build-sdk: patch-dependencies ## Build the SDK package
	npm run build --workspace=@pimote/sdk

build-server: patch-dependencies build-shared build-sdk ## Build the server package (rebuilds shared and SDK)
	npm run build --workspace=@pimote/server

build-client: patch-dependencies ## Build the client package
	npm run build --workspace=client

package: build ## Create a publishable npm tarball in .artifacts
	mkdir -p $(ARTIFACTS_DIR)
	npm pack --ignore-scripts --pack-destination $(ARTIFACTS_DIR)

version: ## Bump the release version everywhere (needs VERSION=x.y.z)
	npm version $(VERSION) --no-git-tag-version

# ── Dev (hot-reload) ──────────────────────────────────────────────────────────

dev: ## Show how to run the dev servers
	@echo "Run these in two separate terminals:"
	@echo "  make dev-server"
	@echo "  make dev-client"

dev-server: ## Run the server with hot reload (tsx watch)
	npm run dev --workspace=@pimote/server

dev-client: ## Run the Vite dev server (proxies /ws to localhost:PORT)
	npm run dev --workspace=client

# ── Production start ──────────────────────────────────────────────────────────

start: ## Run the production app from the repo checkout (optional PORT=)
	node ./bin/pimote.js start $(if $(PORT),--port $(PORT),)

# ── Lint & Format ─────────────────────────────────────────────────────────────

format: ## Format all files with Prettier (writes changes)
	npm run format

format-check: ## Check formatting without writing
	npm run format:check

lint: ## Run ESLint on all files
	npm run lint

check: ## Run type checking (svelte-check + tsc)
	npm run check

# ── Test ──────────────────────────────────────────────────────────────────────

test: patch-dependencies ## Run server, client, and patch tests
	npm run test --workspace=@pimote/server -- --run
	npm run test --workspace=client -- --run
	npm run test:patches

# ── Clean ─────────────────────────────────────────────────────────────────────

clean: ## Remove build artifacts
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

android-image: ## Build the Android build container image
	$(ANDROID_TOOLS)/android-image

android-build: ## Assemble the debug APK in the build container
	$(ANDROID_TOOLS)/android-build

android-test: ## Run Android unit tests in the build container
	$(ANDROID_TOOLS)/run-container -- ./gradlew test

android-connect: ## Connect and verify the wireless debugging phone
	$(ANDROID_TOOLS)/android-connect

android-install: ## Build the debug APK and install it on the phone
	$(ANDROID_TOOLS)/android-install

android-shell: ## Interactive bash shell in the build container
	$(ANDROID_TOOLS)/run-container --interactive -- bash

android-gradle: ## Run a gradle task: make android-gradle ARGS="<task>"
	$(ANDROID_TOOLS)/run-container -- ./gradlew $(ARGS)

android-clean: ## gradle clean in the build container
	$(ANDROID_TOOLS)/run-container -- ./gradlew clean

android-tooling-test: ## Test host device selection (no Docker or phone)
	bash mobile/android/tests/discovery.test.sh

# ── Help ──────────────────────────────────────────────────────────────────────

help: ## Show this help
	@echo ""
	@echo "Usage: make [target] [PORT=3000]"
	@grep -E '^[a-zA-Z_-]+:.*## ' $(firstword $(MAKEFILE_LIST)) | \
		awk '{ n = index($$0, ":"); name = substr($$0, 1, n - 1); desc = substr($$0, index($$0, "## ") + 3); printf "  %-22s %s\n", name, desc }'

