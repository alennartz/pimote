.PHONY: all install build build-shared build-server build-client \
        dev dev-server dev-client \
        start test clean help \
        format format-check lint check \
        deploy undeploy redeploy logs status

# ── Config ────────────────────────────────────────────────────────────────────

# PORT is optional — if not set, the server uses the value from ~/.config/pimote/config.json
# Override with: make start PORT=3001

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

## Run the production build (serves client static files + WebSocket).
## Port comes from ~/.config/pimote/config.json unless PORT= is passed explicitly.
start:
	$(if $(PORT),PORT=$(PORT) ,)node server/dist/index.js

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
	rm -rf server/dist
	rm -rf client/.svelte-kit
	rm -rf client/build

# ── Service ───────────────────────────────────────────────────────────────────

## Build and (re)start the systemd service
deploy: build
	systemctl --user restart pimote

## Stop the service
undeploy:
	systemctl --user stop pimote

## Rebuild and restart
redeploy: build
	systemctl --user restart pimote

## View logs (live)
logs:
	journalctl --user -u pimote -f

## Check status
status:
	systemctl --user status pimote

# ── Help ──────────────────────────────────────────────────────────────────────

help:
	@echo ""
	@echo "Usage: make [target] [PORT=3000]"
	@echo ""
	@echo "  install        Install all workspace dependencies"
	@echo "  build          Build shared → server → client (production)"
	@echo "  build-shared   Build shared types/utils only"
	@echo "  build-server   Build server only (rebuilds shared first)"
	@echo "  build-client   Build client only"
	@echo ""
	@echo "  dev-server     Run server with hot-reload (tsx watch)"
	@echo "  dev-client     Run Vite dev server (proxies /ws to :PORT)"
	@echo ""
	@echo "  start          Start production server (port from config.json, or PORT=N to override)"
	@echo "  test           Run all tests (server + client, single run)"
	@echo ""
	@echo "  format         Format all files with Prettier (writes changes)"
	@echo "  format-check   Check formatting without writing"
	@echo "  lint           Run ESLint on all files"
	@echo "  check          Run type checking (svelte-check + tsc)"
	@echo ""
	@echo "  clean          Remove all build artifacts"
	@echo ""
	@echo "  deploy         Build + (re)start systemd service"
	@echo "  undeploy       Stop the service"
	@echo "  redeploy       Rebuild + restart"
	@echo "  logs           Tail service logs"
	@echo "  status         Show service status"
	@echo ""
	@echo "  help           Show this message"
	@echo ""
