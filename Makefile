.PHONY: all install build build-shared build-server build-client package \
        dev dev-server dev-client \
        start start-installed restart test clean help \
        format format-check lint check \
        install-local install-service deploy redeploy undeploy logs status deploy-paths

# ── Config ────────────────────────────────────────────────────────────────────

# Optional machine-local overrides live in Makefile.local (gitignored).
-include Makefile.local

# PORT is optional — if not set, the server uses the value from ~/.config/pimote/config.json
# Override with: make start PORT=3001

ARTIFACTS_DIR ?= .artifacts
XDG_DATA_HOME ?= $(HOME)/.local/share
XDG_CONFIG_HOME ?= $(HOME)/.config
PIMOTE_INSTALL_ROOT ?= $(XDG_DATA_HOME)/pimote
PIMOTE_PACKAGE_NAME ?= @pimote/pimote
PIMOTE_SERVICE_NAME ?= pimote
PIMOTE_SYSTEMD_UNIT_PATH ?= $(XDG_CONFIG_HOME)/systemd/user/$(PIMOTE_SERVICE_NAME).service
PIMOTE_ENV_FILE ?= $(XDG_CONFIG_HOME)/pimote/env
PIMOTE_KEEP_RELEASES ?= 3
SYSTEMCTL ?= systemctl --user
JOURNALCTL ?= journalctl --user
CURRENT_PACKAGE_DIR := $(PIMOTE_INSTALL_ROOT)/current/node_modules/$(PIMOTE_PACKAGE_NAME)

export XDG_DATA_HOME XDG_CONFIG_HOME
export PIMOTE_INSTALL_ROOT PIMOTE_PACKAGE_NAME PIMOTE_SERVICE_NAME
export PIMOTE_SYSTEMD_UNIT_PATH PIMOTE_ENV_FILE PIMOTE_KEEP_RELEASES

# ── Default ───────────────────────────────────────────────────────────────────

all: build

# ── Install ───────────────────────────────────────────────────────────────────

install:
	npm install

# ── Build ─────────────────────────────────────────────────────────────────────

## Build everything in dependency order: shared → server, then client
build: build-shared build-server build-client

build-shared:
	npm run build --workspace=shared

## Server depends on shared; rebuild shared first if you've changed it
build-server: build-shared
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

## Run the currently installed local deployment package.
start-installed:
	node $(CURRENT_PACKAGE_DIR)/bin/pimote.js start $(if $(PORT),--port $(PORT),)

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

# ── Clean ─────────────────────────────────────────────────────────────────────

clean:
	rm -rf shared/dist
	rm -rf shared/tsconfig.tsbuildinfo
	rm -rf server/dist
	rm -rf server/tsconfig.tsbuildinfo
	rm -rf client/.svelte-kit
	rm -rf client/build
	rm -rf $(ARTIFACTS_DIR)

# ── Local installed deployment ────────────────────────────────────────────────

## Install the built app as a local release under $(PIMOTE_INSTALL_ROOT)
install-local: build
	node ./scripts/install-local-package.mjs

## Write/update the user systemd unit to run the installed package
install-service:
	node ./scripts/install-systemd-service.mjs

## Show the local deployment paths used by deploy/install-service
deploy-paths:
	@echo "Install root:     $(PIMOTE_INSTALL_ROOT)"
	@echo "Current package:  $(CURRENT_PACKAGE_DIR)"
	@echo "Service name:     $(PIMOTE_SERVICE_NAME)"
	@echo "Systemd unit:     $(PIMOTE_SYSTEMD_UNIT_PATH)"
	@echo "Env file:         $(PIMOTE_ENV_FILE)"

# ── Service ───────────────────────────────────────────────────────────────────

## Install the local package release, update the systemd unit, and restart/enable the service
deploy: install-local install-service
	$(SYSTEMCTL) daemon-reload
	$(SYSTEMCTL) enable --now $(PIMOTE_SERVICE_NAME)
	$(SYSTEMCTL) restart $(PIMOTE_SERVICE_NAME)

## Reinstall the local package release and restart the service
redeploy: deploy

## Restart the service
restart:
	$(SYSTEMCTL) restart $(PIMOTE_SERVICE_NAME)

## Stop the service
undeploy:
	$(SYSTEMCTL) stop $(PIMOTE_SERVICE_NAME)

## View logs (live)
logs:
	$(JOURNALCTL) -u $(PIMOTE_SERVICE_NAME) -f

## Check status
status:
	$(SYSTEMCTL) status $(PIMOTE_SERVICE_NAME)

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
	@echo "  start-installed  Start the installed local deployment"
	@echo "  test             Run all tests (server + client, single run)"
	@echo ""
	@echo "  format           Format all files with Prettier (writes changes)"
	@echo "  format-check     Check formatting without writing"
	@echo "  lint             Run ESLint on all files"
	@echo "  check            Run type checking (svelte-check + tsc)"
	@echo ""
	@echo "  clean            Remove all build artifacts"
	@echo ""
	@echo "  install-local    Install the app into $(PIMOTE_INSTALL_ROOT)"
	@echo "  install-service  Write/update the user systemd unit ($(PIMOTE_SYSTEMD_UNIT_PATH))"
	@echo "  deploy-paths     Show local deployment paths"
	@echo "  deploy           Install local release + update unit + restart service"
	@echo "                   (override locally via Makefile.local)"
	@echo "  redeploy         Alias for deploy"
	@echo "  restart          Restart the service"
	@echo "  undeploy         Stop the service"
	@echo "  logs             Tail service logs"
	@echo "  status           Show service status"
	@echo ""
	@echo "  help             Show this message"
	@echo ""
