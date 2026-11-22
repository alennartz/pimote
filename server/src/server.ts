import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { PimoteConfig } from './config.js';
import type { PimoteSessionManager } from './session-manager.js';
import type { SessionRecords } from './session-records.js';
import type { PushNotificationService } from './push-notification.js';
import type { FileSessionMetadataStore } from './session-metadata.js';
import { WsHandler, takeOverClientSlot, type ClientRegistry, type WsGlobalSettingsDependencies } from './ws-handler.js';
import { startWebSocketHeartbeat } from './ws-heartbeat.js';
import type { RepoIndex } from './repo-index.js';
import type { FolderRegistry } from './folder-registry.js';
import type { FolderListingService } from './folder-listing.js';
import type { VoiceOrchestrator } from './voice-orchestrator.js';
import { serveStaticHostRoute, type StaticHostRegistry } from './static-host/index.js';
import { applyAppNameToHtml, applyAppNameToManifest, resolveAppName } from './branding.js';
import { serveFileDownloadRoute, type DownloadManager } from './file-download/index.js';
import type { UserProfiles } from './user-profiles.js';
import type { ThemeCatalog } from './theme-catalog.js';
import crypto from 'node:crypto';
import type { UpdateAvailableEvent, VersionMismatchEvent, ServerCapabilitiesEvent, ThemeCatalogChangedEvent, AppsChangedEvent } from '../../shared/dist/index.js';
import type { AppService } from './apps/index.js';
import { createAppIconProxy } from './apps/icon-proxy.js';
import type { UpdateChecker } from './update-check.js';
import { resolveUserName } from './user-profiles.js';
import { handleImageHttpRoute } from './image-http.js';
import { ThemePreferences } from './theme-preferences.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
/** Directory holding the built client bundle. Resolved per call so tests can point it elsewhere. */
function clientDir(): string {
  return process.env.CLIENT_DIR || join(__dirname, '..', '..', 'client', 'build');
}

/** Read the SvelteKit build version from _app/version.json. Returns null if unavailable. */
async function loadClientVersion(): Promise<string | null> {
  try {
    const raw = await readFile(join(clientDir(), '_app', 'version.json'), 'utf-8');
    const data = JSON.parse(raw);
    return data.version ?? null;
  } catch {
    return null;
  }
}

const CONTROL_DOCUMENT_CSP = "frame-ancestors 'none'";

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Try to serve a static file from the client dir. Returns true if served.
 * Branded surfaces (PWA manifest, HTML shell) are rewritten to `appName`.
 */
async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, appName: string): Promise<boolean> {
  const urlPath = req.url === '/' ? '/index.html' : req.url!.split('?')[0];
  const dir = clientDir();
  const filePath = join(dir, urlPath);

  // Prevent directory traversal — ensure path is within the client dir
  if (!filePath.startsWith(dir + '/') && filePath !== dir) {
    return false;
  }

  try {
    const stats = await stat(filePath);
    if (stats.isFile()) {
      const ext = extname(filePath);
      const mime = MIME_TYPES[ext] || 'application/octet-stream';
      let content: Buffer | string = await readFile(filePath);
      const headers: Record<string, string> = {
        'Content-Type': mime,
        'Content-Security-Policy': CONTROL_DOCUMENT_CSP,
      };

      if (urlPath === '/pwa/manifest.json') {
        content = applyAppNameToManifest(content.toString('utf-8'), appName);
      } else if (ext === '.html') {
        content = applyAppNameToHtml(content.toString('utf-8'), appName);
      }

      // HTML, SW, and manifest must not be cached by CDN/proxies.
      // Immutable hashed assets (_app/immutable/) are safe to cache.
      if (urlPath === '/sw.js' || urlPath === '/pwa/manifest.json' || ext === '.html') {
        headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
        headers['CDN-Cache-Control'] = 'no-store';
        headers['Cloudflare-CDN-Cache-Control'] = 'no-store';
      } else if (urlPath.startsWith('/_app/immutable/')) {
        headers['Cache-Control'] = 'public, max-age=31536000, immutable';
      }

      res.writeHead(200, headers);
      res.end(content);
      return true;
    }
  } catch {
    // File not found — fall through
  }
  return false;
}

/** Serve index.html as SPA fallback. */
async function serveFallback(res: http.ServerResponse, appName: string): Promise<void> {
  try {
    const indexPath = join(clientDir(), 'index.html');
    const content = await readFile(indexPath, 'utf-8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': CONTROL_DOCUMENT_CSP,
    });
    res.end(applyAppNameToHtml(content, appName));
  } catch {
    res.writeHead(404, {
      'Content-Type': 'application/json',
      'Content-Security-Policy': CONTROL_DOCUMENT_CSP,
    });
    res.end(JSON.stringify({ error: 'not found' }));
  }
}

export interface PimoteServer {
  httpServer: http.Server;
  wss: WebSocketServer;
  clientRegistry: ClientRegistry;
  start(port: number): Promise<void>;
  close(): Promise<void>;
}

export async function createServer(
  config: PimoteConfig,
  sessionManager: PimoteSessionManager,
  sessionRecords: SessionRecords,
  pushNotificationService: PushNotificationService,
  sessionMetadataStore: FileSessionMetadataStore,
  voiceOrchestrator: VoiceOrchestrator | undefined,
  staticHostRegistry: StaticHostRegistry,
  fileDownloads: DownloadManager,
  updateChecker?: UpdateChecker,
  repoIndex?: RepoIndex,
  folderRegistry?: FolderRegistry,
  folderListing?: FolderListingService,
  globalSettings?: WsGlobalSettingsDependencies,
  userProfiles?: UserProfiles,
  themeCatalog?: Pick<ThemeCatalog, 'snapshot' | 'onChange' | 'setDefaultTheme'>,
  appService?: AppService,
): Promise<PimoteServer> {
  const effectiveThemeCatalog = themeCatalog ?? globalSettings?.themeCatalog;
  const effectiveAppService = appService ?? globalSettings?.appService;
  const serveAppIconRoute = effectiveAppService ? createAppIconProxy({ source: effectiveAppService }) : undefined;
  const appName = resolveAppName(config);
  const clientVersion = await loadClientVersion();
  if (clientVersion) {
    console.log(`[pimote] Client build version: ${clientVersion}`);
  } else {
    console.warn(`[pimote] Could not read client build version from ${clientDir()}/_app/version.json`);
  }
  const httpServer = http.createServer(async (req, res) => {
    // Content-addressed image bodies stay off the WebSocket transcript path.
    if (await handleImageHttpRoute(req, res)) return;

    // App icons are proxied same-origin so the browser never loads cross-origin images.
    if (serveAppIconRoute && (await serveAppIconRoute(req, res))) return;

    // 1. Health check
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // 2. VAPID public key for push notification subscription
    if (req.method === 'GET' && req.url === '/api/vapid-key') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ publicKey: config.vapidPublicKey ?? '' }));
      return;
    }

    // 3. Static file lookup
    if (req.method === 'GET') {
      const served = await serveStatic(req, res, appName);
      if (served) return;
    }

    // 3b. One-shot file downloads — handled before SPA fallback and never
    // selected by a filesystem path supplied in the request.
    if (req.method === 'GET') {
      const handled = await serveFileDownloadRoute(req, res, fileDownloads);
      if (handled) return;
    }

    // 3c. Static-host route — /s/<slug>/* serves agent-registered bundles.
    // Unknown slugs return 404 from the handler and do NOT fall through to the SPA.
    if (req.method === 'GET' || req.method === 'HEAD') {
      const handled = await serveStaticHostRoute(req, res, staticHostRegistry);
      if (handled) return;
    }

    // 4. SPA fallback — serve index.html for unmatched GET routes
    if (req.method === 'GET') {
      await serveFallback(res, appName);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  // Wire up session manager callbacks for sidebar broadcasts. Status and close
  // callbacks also invalidate the folder listing's session-derived metadata for
  // the affected folder — session activity, so no folder delta.
  sessionManager.onStatusChange = (sessionId, folderPath) => {
    folderListing?.invalidateSessionMetadata([folderPath]);
    WsHandler.broadcastSidebarUpdate(sessionId, folderPath, sessionManager, clientRegistry);
  };
  sessionManager.onSessionClosed = (sessionId, folderPath) => {
    folderListing?.invalidateSessionMetadata([folderPath]);
    WsHandler.broadcastSidebarUpdate(sessionId, folderPath, sessionManager, clientRegistry);
  };
  sessionManager.onGitBranchChange = (sessionId, folderPath) => {
    WsHandler.broadcastSidebarUpdate(sessionId, folderPath, sessionManager, clientRegistry);
  };
  // A re-key collision evicts the existing slot before the runtime is disposed.
  sessionManager.onSlotEvicted = (sessionId) => {
    const slot = sessionManager.getSlot(sessionId);
    if (!slot) return;
    for (const clientId of slot.observers.keys()) {
      clientRegistry.get(clientId)?.sendSessionClosedEvent(sessionId, 'replaced');
    }
  };

  // A shared rekey moves every holder's profile link to the new id and tells
  // each affected user's connections. Observing connections are excluded —
  // they are about to receive session_replaced and apply the swap locally.
  // The hook fires even for observerless slots, so holders follow extension-
  // and voice-driven switches too.
  sessionManager.onSlotRekeyed = (oldId, newId, folderPath, observerClientIds) => {
    if (!userProfiles) return;
    return WsHandler.relinkSessionAcrossRekey(userProfiles, clientRegistry, oldId, newId, folderPath, observerClientIds);
  };

  // Folder registry mutations (update / createHub / membership) report the
  // exact changed/removed paths (their targets plus derived dependents) and
  // broadcast through the same delta channel. The listing service builds the
  // delta; the emitter only sends it.
  folderRegistry?.onChange((change) => {
    WsHandler.broadcastFoldersChanged(folderListing, change.changedPaths, change.removedPaths, clientRegistry);
  });

  // A stale-serve background refresh of the repo index (listing/status TTL
  // expiry) rides the same channel with its concrete change targets, but only
  // when the recomputed view differs from what the stale serve returned.
  repoIndex?.setOnRefreshed((change) => {
    if (folderRegistry) WsHandler.broadcastFoldersChanged(folderListing, change.changedPaths, change.removedPaths, clientRegistry);
  });

  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: {
      threshold: 1024,
      clientNoContextTakeover: true,
      serverNoContextTakeover: true,
    },
  });
  const clientRegistry: ClientRegistry = new Map();
  const themePreferences = effectiveThemeCatalog && userProfiles ? new ThemePreferences({ catalog: effectiveThemeCatalog, profiles: userProfiles }) : undefined;
  const stopThemeCatalogSubscription = effectiveThemeCatalog?.onChange((snapshot) => {
    const event: ThemeCatalogChangedEvent = { type: 'theme_catalog_changed', revision: snapshot.revision };
    for (const handler of clientRegistry.values()) handler.sendToClient(event);
  });
  const stopAppsSubscription = effectiveAppService?.onChange((snapshot) => {
    const event: AppsChangedEvent = { type: 'apps_changed', apps: snapshot.apps, sync: snapshot.sync };
    for (const handler of clientRegistry.values()) handler.sendToClient(event);
  });

  // Liveness heartbeat — see ws-heartbeat.ts for why this exists. 20s sits
  // under the ~30s idle drops observed through some proxy paths.
  const heartbeat = startWebSocketHeartbeat(wss, 20_000);

  httpServer.on('upgrade', (req, socket, head) => {
    // Only pathname/searchParams are read, so a fixed base is sufficient — and
    // avoids an uncaught `new URL` throw when a malformed Host header arrives.
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
    ws.on('error', (err) => {
      console.error('[pimote] WebSocket error:', err);
    });

    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      ws.close();
      return;
    }
    const clientId = url.searchParams.get('clientId') ?? crypto.randomUUID();
    const user = resolveUserName(url.searchParams.get('user'));
    type InboundFrameType = 'pong' | 'message' | 'ping';
    const inboundState: { type: InboundFrameType | null; at: number | null } = { type: null, at: null };
    const recordInboundFrame = (type: InboundFrameType): void => {
      inboundState.type = type;
      inboundState.at = Date.now();
    };
    ws.on('pong', () => recordInboundFrame('pong'));
    ws.on('ping', () => recordInboundFrame('ping'));
    heartbeat.track(ws, (details) => {
      console.warn(
        `[pimote] WebSocket heartbeat termination (clientId=${clientId}, consecutiveMisses=${details.consecutiveMisses}, lastInboundType=${details.lastInboundType ?? 'none'}, lastInboundAgeMs=${details.lastInboundAgeMs ?? 'none'})`,
      );
    });
    console.log(`[pimote] WebSocket client connected (clientId=${clientId}, user=${user})`);

    // Version check — if the client's build version doesn't match the server's,
    // send a version_mismatch event and close. The client will reload.
    const incomingVersion = url.searchParams.get('version');
    if (clientVersion && incomingVersion && incomingVersion !== clientVersion) {
      console.log(`[pimote] Version mismatch: client=${incomingVersion}, server=${clientVersion} — requesting reload`);
      const event: VersionMismatchEvent = { type: 'version_mismatch', serverVersion: clientVersion };
      ws.send(JSON.stringify(event), () => ws.close());
      return;
    }

    // Same-id takeover semantics (register replacement first, then evict)
    // live in takeOverClientSlot.
    const handler = new WsHandler(
      config.managerRoot,
      sessionManager,
      sessionRecords,
      ws,
      pushNotificationService,
      sessionMetadataStore,
      clientId,
      clientRegistry,
      voiceOrchestrator,
      repoIndex,
      folderRegistry,
      folderListing,
      globalSettings?.reloadPimoteExtensions,
      globalSettings,
      userProfiles,
      user,
      themePreferences,
      effectiveAppService,
    );
    takeOverClientSlot(clientRegistry, clientId, handler);

    // Advertise capabilities once per connection so clients can hide
    // affordances for disabled features. Voice is enabled iff an
    // orchestrator was wired at boot (it is only built when speechmux is
    // configured — see voice-orchestrator-boot.ts).
    const capabilities: ServerCapabilitiesEvent = globalSettings?.capabilities?.() ?? {
      type: 'server_capabilities',
      voice: voiceOrchestrator !== undefined,
      apps: effectiveAppService !== undefined,
      tagSnippets: [],
    };
    handler.sendToClient(capabilities);

    // Connect burst: the user's profile — open-session set, chip order, and
    // selected session — with the derived freshness flag. `fresh` gates the
    // client's one-time migration of its pre-existing local set; a reconnecting
    // client lands on `selectedSessionId` without replaying missed follows.
    if (userProfiles) {
      handler.sendToClient(WsHandler.userSessionsEvent(userProfiles, user));
    }

    ws.on('message', (data) => {
      recordInboundFrame('message');
      handler.handleMessage(data.toString()).catch((err) => {
        console.error('[pimote] Unhandled error in message handler:', err);
      });
    });

    ws.on('close', (code, reason) => {
      const lastInboundAgeMs = inboundState.at === null ? null : Math.max(0, Date.now() - inboundState.at);
      console.log(
        `[pimote] WebSocket client disconnected (clientId=${clientId}, code=${code}, reason=${JSON.stringify(reason.toString('utf8'))}, lastInboundType=${inboundState.type ?? 'none'}, lastInboundAgeMs=${lastInboundAgeMs ?? 'none'})`,
      );
      // Only clean up if this handler is still the current entry.
      // If a new handler replaced us (stale-connection reconnect), the new
      // handler owns the sessions — don't orphan them.
      if (clientRegistry.get(clientId) === handler) {
        clientRegistry.delete(clientId);
        handler.cleanup();
      }
    });

    if (updateChecker) {
      void updateChecker.getStatus().then((status) => {
        if (!status) return;
        const event: UpdateAvailableEvent = { type: 'update_available', ...status };
        handler.sendToClient(event);
      });
    }
  });

  return {
    httpServer,
    wss,
    clientRegistry,
    start(port: number): Promise<void> {
      return new Promise((resolve) => {
        httpServer.listen(port, () => {
          resolve();
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        stopThemeCatalogSubscription?.();
        stopAppsSubscription?.();
        heartbeat.stop();

        // Force-close all active WebSocket connections
        wss.clients.forEach((client) => {
          client.close();
        });

        // Close the WebSocket server with a timeout to prevent hanging
        const timeout = setTimeout(() => {
          console.warn('[pimote] WebSocket server close timeout — forcing shutdown');
          httpServer.close((err) => {
            if (err) reject(err);
            else resolve();
          });
        }, 5000);

        wss.close((err) => {
          clearTimeout(timeout);
          if (err) {
            reject(err);
          } else {
            httpServer.close((err) => {
              if (err) reject(err);
              else resolve();
            });
          }
        });
      });
    },
  };
}
