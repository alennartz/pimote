import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve, sep } from 'node:path';
import {
  createAgentSessionRuntime,
  createAgentSessionServices,
  createAgentSessionFromServices,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  createEventBus,
  ModelRuntime,
  getAgentDir,
  SessionManager as PiSessionManager,
} from '@earendil-works/pi-coding-agent';
import type { AgentSession, AgentSessionRuntime, EventBusController, CreateAgentSessionRuntimeFactory, ExtensionCommandContextActions } from '@earendil-works/pi-coding-agent';
import type { PimoteConfig } from './config.js';
import { EventBuffer } from './event-buffer.js';
import { QUEUE_KINDS, QueueOwnership, type QueueTexts } from './queue-ownership.js';
import { extractMessageEntryIds, rendererRegisteredVisibility } from './message-mapper.js';
import type { PimoteEvent, Card, DownloadItem, DownloadSnapshotUpdateEvent, DownloadUpdateEvent, SessionSettingsChangedEvent, SubagentSnapshot } from '../../shared/dist/index.js';
import type { PushNotificationPayload, PushNotificationService } from './push-notification.js';
import { applyPanelMessage, getMergedPanelCards } from './panel-state.js';
import { createExtensionUIBridge } from './extension-ui-bridge.js';
import { sendSlotEvent } from './session-slot.js';
export { sendSlotEvent, waitForSlotUiResponse, resolveSlotPendingUi, resolveAllSlotPendingUi, replaySlotPendingUiRequests } from './session-slot.js';
import { askActivity } from '@pimote/sdk/activity';
import { getGitBranch } from './git-branch.js';
import { LoginOrchestrator } from './login-orchestrator.js';
import { createVoiceExtension } from './voice/index.js';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { loadManagerExtension } from './manager/attachment.js';
import { discoverProvider, type BorrowedAgentSession, type SubagentProvider, type SubagentProviderDiscovery } from '@pimote/sdk/subagents';
import { createSubagentHost, type SubagentHost, type SubagentViewChange } from './subagent-host.js';
import { createSessionSurface, type SessionSurfaceCapabilities } from './session-surface.js';

/** Narrow interface for the WebSocket used for event routing.
 *  Avoids importing the `ws` package type in session-manager. */
export interface EventSocket {
  send(data: string, cb?: (err?: Error) => void): void;
  readonly readyState: number;
}

export interface SessionManagerOptions {
  /** Supplies the current effective configuration for new consumers. */
  configSupplier?: () => PimoteConfig;
  staticHostFactory?: ExtensionFactory;
  fileDownloadFactory?: ExtensionFactory;
  /** Injects the `pimote-docs` system-prompt section into every session. */
  pimoteDocsFactory?: ExtensionFactory;
  /** Included only when canonical session cwd equals canonical managerRoot.
   * Manager sessions use the ordinary persisted session and slot lifecycle. */
  managerExtensionFactory?: ExtensionFactory;
  /** Returns whether the current slot is owned by an active voice call. */
  isVoiceModeActive?: (slot: ManagedSlot) => boolean;
  /** Grace period for restoring child-view leases after a socket reconnect. */
  subagentReconnectGraceMs?: number;
}

export interface PendingUiEntry {
  resolve: (value: unknown) => void;
  /** The original request event, stored so it can be re-sent on reconnect. */
  event: PimoteEvent;
}

/** Outcome of a session reset, passed to an observer's notify callback after
 * the slot state has been rebuilt and any map re-key is complete. */
export type SessionResetOutcome = { kind: 'unchanged' } | { kind: 'rekeyed'; oldId: string; newId: string; folderPath: string };

/** One live client observer of a managed session. The event cursor is the last
 * buffered event delivered to this observer. */
export interface SessionObserver {
  clientId: string;
  ws: EventSocket;
  cursor: number;
  onSessionReset: ((slot: ManagedSlot, outcome: SessionResetOutcome, isFirstObserver?: boolean) => Promise<void>) | null;
}

export interface SessionState {
  id: string;
  eventBuffer: EventBuffer;
  status: 'idle' | 'working';
  needsAttention: boolean;
  /** Timestamp the session entered the idle state (last `agent_end`), or null while `status === 'working'`.
   *  The reaper uses this to decide eligibility — a streaming session is never reapable.
   *  Client connect/disconnect does NOT reset this clock; idleness is purely an agent-level concept. */
  idleSince: number | null;
  unsubscribe: () => void;
  pendingUiResponses: Map<string, PendingUiEntry>;
  extensionsBound: boolean;
  panelState: Map<string, Card[]>;
  /** Current pending file-download snapshot for this session. */
  downloads: DownloadItem[];
  /** Removes this state's dedicated download EventBus listener during teardown. */
  downloadListenerUnsub?: () => void;
  panelListenerUnsubs: (() => void)[];
  panelThrottleTimer: ReturnType<typeof setTimeout> | null;
  /** The concrete AgentSession this state subscribes to. Session IDs can repeat across replacements. */
  sessionIdentity: AgentSession;
  /** True while a tree navigation + optional summarization is in progress. */
  treeNavigationInProgress: boolean;
  /** True from bash admission through extension interception/native execution. */
  bashDispatchInProgress?: boolean;
  /** Set when abort_bash arrives before native execution has been admitted. */
  bashAbortRequested?: boolean;
  /** Which client submitted each message in pi's steering and follow-up queues. */
  queueOwnership: QueueOwnership;
  /** Abort-drained drafts for senders that were offline, delivered on their next claim. */
  undeliveredDrafts?: Map<string, QueueTexts>;
}

export type SubagentViewListener = (change: SubagentViewChange, incarnation?: string, viewCursor?: number) => void;

export interface ManagedSlot {
  runtime: AgentSessionRuntime;
  folderPath: string;
  eventBusRef: { current: EventBusController | null };
  observers: Map<string, SessionObserver>;
  sessionState: SessionState;
  /** Root-scoped provider host. Children never become managed slots. */
  subagentHost?: SubagentHost;
  subagentProvider?: SubagentProvider;
  subagentDiscovery?: SubagentProviderDiscovery;
  subagentDiscoveryUnsubscribe?: () => void;
  subagentDiscoveryBus?: EventBusController | null;
  subagentTransition?: Promise<void>;
  subagentClosed?: boolean;
  subagentViewListeners?: Map<string, SubagentViewListener>;
  get session(): AgentSession;
}

/** Lifecycle operation admitted by the slot guard. */
export type SlotLifecycleKind = 'reset' | 'close';

/** Error returned when a second lifecycle operation races the first one. */
export class SessionLifecycleError extends Error {
  readonly code = 'session_reset_in_progress';

  constructor() {
    super('session_reset_in_progress');
    this.name = 'SessionLifecycleError';
  }
}

type SlotLifecyclePhase = 'preparing' | 'binding' | 'post' | 'closing';
type SlotLifecycleFrameKind = 'wrapper' | 'runtime';

interface SlotLifecycleFrame {
  kind: SlotLifecycleFrameKind;
  parent?: SlotLifecycleFrame;
  child?: SlotLifecycleFrame;
  childSettled?: Promise<void>;
  resolveChildSettled?: () => void;
  phase?: SlotLifecyclePhase;
  done: boolean;
}

interface SlotLifecycleState {
  active?: {
    kind: SlotLifecycleKind;
    owner: symbol;
    phase: SlotLifecyclePhase;
    rootFrame?: SlotLifecycleFrame;
  };
  /** True after pi has invalidated the outgoing session during a reset. */
  resetStarted: boolean;
}

interface SlotLifecycleContext {
  slot: ManagedSlot;
  owner: symbol;
  frame?: SlotLifecycleFrame;
}

export interface SlotLifecycleOptions {
  allowPreparingNested?: boolean;
}

const slotLifecycleStates = new WeakMap<ManagedSlot, SlotLifecycleState>();
const slotLifecycleContext = new AsyncLocalStorage<SlotLifecycleContext>();

/** Whether `child` is `ancestor` itself or lives strictly below it. */
function isWithin(child: string, ancestor: string): boolean {
  return child === ancestor || child.startsWith(ancestor + sep);
}

function lifecycleStateFor(slot: ManagedSlot): SlotLifecycleState {
  let state = slotLifecycleStates.get(slot);
  if (!state) {
    state = { resetStarted: false };
    slotLifecycleStates.set(slot, state);
  }
  return state;
}

function sameLifecycleOwner(slot: ManagedSlot, active: NonNullable<SlotLifecycleState['active']> | undefined): boolean {
  const context = slotLifecycleContext.getStore();
  return active !== undefined && context?.slot === slot && context.owner === active.owner;
}

/** Return true while the current async call owns this slot's lifecycle guard. */
export function isSlotLifecycleOwner(slot: ManagedSlot): boolean {
  return sameLifecycleOwner(slot, lifecycleStateFor(slot).active);
}

/** True for a reentrant call made from an admitted runtime callback. */
export function isNestedSlotLifecycle(slot: ManagedSlot): boolean {
  const context = slotLifecycleContext.getStore();
  return isSlotLifecycleOwner(slot) && context?.frame?.kind === 'runtime';
}

function isSafeNestedPhase(phase: SlotLifecyclePhase): boolean {
  return phase === 'binding' || phase === 'post';
}

function phaseForFrame(slot: ManagedSlot, frame: SlotLifecycleFrame | undefined): SlotLifecyclePhase {
  let current = frame;
  while (current) {
    if (current.kind === 'runtime') return current.phase ?? 'preparing';
    current = current.parent;
  }
  return lifecycleStateFor(slot).active?.phase ?? 'preparing';
}

function maybeReleaseSlot(slot: ManagedSlot): void {
  const state = lifecycleStateFor(slot);
  const active = state.active;
  if (!active || active.rootFrame) return;
  state.active = undefined;
  state.resetStarted = false;
}

function releaseLifecycleFrame(slot: ManagedSlot, frame: SlotLifecycleFrame): void {
  const state = lifecycleStateFor(slot);
  frame.done = true;
  let current: SlotLifecycleFrame | undefined = frame;
  while (current && current.done && !current.child) {
    const parent: SlotLifecycleFrame | undefined = current.parent;
    if (parent) {
      if (parent.child === current) {
        parent.child = undefined;
        parent.resolveChildSettled?.();
        parent.childSettled = undefined;
        parent.resolveChildSettled = undefined;
      }
    } else if (state.active?.rootFrame === current) {
      state.active.rootFrame = undefined;
    }
    current = parent;
  }
  maybeReleaseSlot(slot);
}

function attachLifecycleFrame(slot: ManagedSlot, active: NonNullable<SlotLifecycleState['active']>, frame: SlotLifecycleFrame): void {
  if (frame.parent) {
    frame.parent.child = frame;
    frame.parent.childSettled = new Promise<void>((resolve) => {
      frame.parent!.resolveChildSettled = resolve;
    });
  } else {
    active.rootFrame = frame;
  }
}

function waitForLifecycleChildren(frame: SlotLifecycleFrame | undefined): Promise<void> {
  return frame?.childSettled ?? Promise.resolve();
}

function setSlotLifecyclePhase(slot: ManagedSlot, phase: SlotLifecyclePhase): SlotLifecyclePhase | undefined {
  const active = lifecycleStateFor(slot).active;
  if (!active) return undefined;
  const previous = active.phase;
  active.phase = phase;
  return previous;
}

/**
 * Admit a WebSocket or extension lifecycle entry point. Runtime methods use
 * `runSlotRuntime` below for the finer-grained replacement admission.
 */
export async function runSlotLifecycle<T>(slot: ManagedSlot, kind: SlotLifecycleKind, operation: () => Promise<T>, options: SlotLifecycleOptions = {}): Promise<T> {
  const state = lifecycleStateFor(slot);
  const active = state.active;
  const context = slotLifecycleContext.getStore();
  let owner: symbol;
  let parent: SlotLifecycleFrame | undefined;

  if (!active) {
    owner = Symbol('slot-lifecycle');
    state.active = {
      kind,
      owner,
      phase: kind === 'reset' ? 'preparing' : 'closing',
    };
    if (kind === 'reset') state.resetStarted = false;
  } else {
    owner = active.owner;
    if (!sameLifecycleOwner(slot, active) || (active.kind === 'close' && kind === 'reset')) throw new SessionLifecycleError();
    parent = context?.slot === slot && context.owner === owner ? context.frame : undefined;
    if (kind === 'reset' && active.kind === 'reset' && parent && !isSafeNestedPhase(phaseForFrame(slot, parent)) && !options.allowPreparingNested) {
      throw new SessionLifecycleError();
    }
    if (parent?.done || parent?.child) throw new SessionLifecycleError();
  }

  const current = state.active!;
  const frame: SlotLifecycleFrame = { kind: 'wrapper', parent, done: false };
  attachLifecycleFrame(slot, current, frame);
  return slotLifecycleContext.run({ slot, owner, frame }, async () => {
    try {
      return await operation();
    } finally {
      releaseLifecycleFrame(slot, frame);
    }
  });
}

/** Admit one runtime replacement or disposal at the slot boundary. */
async function runSlotRuntime<T>(slot: ManagedSlot, kind: SlotLifecycleKind, operation: () => Promise<T>): Promise<T> {
  const state = lifecycleStateFor(slot);
  let active = state.active;
  const context = slotLifecycleContext.getStore();
  let owner: symbol;
  let parent: SlotLifecycleFrame | undefined;

  if (!active) {
    owner = Symbol('slot-lifecycle');
    active = {
      kind,
      owner,
      phase: kind === 'reset' ? 'preparing' : 'closing',
    };
    state.active = active;
    if (kind === 'reset') state.resetStarted = false;
  } else {
    owner = active.owner;
    if (!sameLifecycleOwner(slot, active) || (active.kind === 'close' && kind === 'reset')) throw new SessionLifecycleError();
    parent = context?.slot === slot && context.owner === owner ? context.frame : undefined;
    if (kind === 'reset') {
      const rootWrapperDelegation = parent?.kind === 'wrapper' && parent.parent === undefined;
      if (parent && !rootWrapperDelegation && !isSafeNestedPhase(phaseForFrame(slot, parent))) {
        throw new SessionLifecycleError();
      }
      if (parent?.done || parent?.child) throw new SessionLifecycleError();
    } else if (parent?.done || parent?.child) {
      throw new SessionLifecycleError();
    }
  }

  const current = state.active!;
  const frame: SlotLifecycleFrame = { kind: 'runtime', parent, phase: kind === 'reset' ? 'preparing' : 'closing', done: false };
  attachLifecycleFrame(slot, current, frame);
  return slotLifecycleContext.run({ slot, owner, frame }, async () => {
    try {
      return await operation();
    } finally {
      releaseLifecycleFrame(slot, frame);
    }
  });
}

/** Mark the current runtime frame after Pi applies its replacement. */
function markCurrentRuntimePhase(slot: ManagedSlot, phase: SlotLifecyclePhase): void {
  const state = lifecycleStateFor(slot);
  const active = state.active;
  const context = slotLifecycleContext.getStore();
  if (!active || context?.slot !== slot || context.owner !== active.owner) {
    setSlotLifecyclePhase(slot, phase);
    return;
  }
  let frame = context.frame;
  while (frame && frame.kind !== 'runtime') frame = frame.parent;
  if (frame) {
    frame.phase = phase;
  } else {
    active.phase = phase;
  }
}

/** Mark the point where Pi has applied a replacement and starts rebinding. */
function markRuntimeReplacementApplied(slot: ManagedSlot): void {
  markCurrentRuntimePhase(slot, 'binding');
}

/**
 * Wrap runtime replacement methods at the slot boundary. Pi's runtime has no
 * admission serialization, so every dynamic call must pass this proxy before
 * it can tear down the current session or start a factory.
 */
function guardSlotRuntime(slot: ManagedSlot, runtime: AgentSessionRuntime, onResetFailure: (slot: ManagedSlot) => Promise<void>): AgentSessionRuntime {
  const hasInvalidationHook = typeof runtime.setBeforeSessionInvalidate === 'function';
  runtime.setBeforeSessionInvalidate?.(() => {
    const state = lifecycleStateFor(slot);
    if (state.active?.kind === 'reset') {
      markCurrentRuntimePhase(slot, 'preparing');
      state.resetStarted = true;
    }
  });

  const resetMethods = new Set(['newSession', 'fork', 'switchSession', 'importFromJsonl']);
  const closeMethods = new Set(['dispose']);
  return new Proxy(runtime, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function' || typeof property !== 'string' || (!resetMethods.has(property) && !closeMethods.has(property))) {
        return value;
      }
      const kind: SlotLifecycleKind = closeMethods.has(property) ? 'close' : 'reset';
      return (...args: unknown[]) =>
        runSlotRuntime(slot, kind, async () => {
          const state = lifecycleStateFor(slot);
          if (kind === 'reset' && !hasInvalidationHook) state.resetStarted = true;
          try {
            return await Reflect.apply(value, target, args);
          } catch (error) {
            if (kind === 'reset' && state.resetStarted) {
              try {
                await waitForLifecycleChildren(slotLifecycleContext.getStore()?.frame);
                await onResetFailure(slot);
              } catch (cleanupError) {
                throw new AggregateError([error, cleanupError], 'Session reset and cleanup failed', { cause: cleanupError });
              }
            }
            throw error;
          }
        });
    },
  });
}

// ---- Slot-based helpers (operate on ManagedSlot) ----

/** Dependencies for routing one extension download update to its owning client. */
export interface DownloadEventBus {
  on(type: 'pimote:downloads', listener: (update: unknown) => void | Promise<void>): () => void;
}

export interface RouteSlotDownloadUpdateOptions {
  sessionId: string;
  folderPath: string;
  sessionName?: string;
  state: Pick<SessionState, 'downloads'>;
  send(event: DownloadUpdateEvent): void;
  notify(payload: PushNotificationPayload): Promise<void>;
}

/** True when an untrusted EventBus payload has the public download-item shape. */
function isDownloadItem(value: unknown): value is DownloadItem {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string' && typeof item.filename === 'string' && typeof item.sizeBytes === 'number' && Number.isFinite(item.sizeBytes) && typeof item.href === 'string';
}

/** True when an untrusted EventBus payload has one of the download-update shapes. */
function isDownloadUpdateEvent(value: unknown): value is DownloadUpdateEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const update = value as Record<string, unknown>;
  if (update.type !== 'download_update' || typeof update.sessionId !== 'string' || !Array.isArray(update.downloads) || !update.downloads.every(isDownloadItem)) {
    return false;
  }
  if (update.cause === 'offered') return typeof update.offeredDownloadId === 'string';
  return update.cause === 'restored' || update.cause === 'consumed' || update.cause === 'revoked';
}

/** Subscribe one session state to extension download updates. */
export function setupSlotDownloadListener(eventBus: DownloadEventBus, options: RouteSlotDownloadUpdateOptions): () => void {
  return eventBus.on('pimote:downloads', async (update) => {
    if (!isDownloadUpdateEvent(update) || update.sessionId !== options.sessionId) return;
    await routeSlotDownloadUpdate(update, options);
  });
}

/** Build the silent full snapshot used after reconnect, resync, and view changes. */
export function makeDownloadSnapshot(sessionId: string, downloads: DownloadItem[]): DownloadSnapshotUpdateEvent {
  return { type: 'download_update', sessionId, cause: 'restored', downloads };
}

/**
 * Apply an extension update to session-local state, route it to the current
 * owner, and emit VAPID only for a newly offered item. The implementation
 * validates that the update belongs to this session and resolves
 * `offeredDownloadId` from the full snapshot before notifying.
 */
export async function routeSlotDownloadUpdate(update: DownloadUpdateEvent, options: RouteSlotDownloadUpdateOptions): Promise<void> {
  if (update.sessionId !== options.sessionId) return;

  options.state.downloads = update.downloads;
  options.send(update);

  if (update.cause !== 'offered') return;
  const offered = update.downloads.find((download) => download.id === update.offeredDownloadId);
  if (!offered) return;

  const projectName = options.folderPath.split('/').filter(Boolean).at(-1) ?? 'Unknown';
  try {
    await options.notify({
      projectName,
      folderPath: options.folderPath,
      sessionId: options.sessionId,
      sessionName: options.sessionName,
      reason: 'download',
      download: {
        downloadId: offered.id,
        filename: offered.filename,
        sizeBytes: offered.sizeBytes,
      },
    });
  } catch (error) {
    console.error('[SessionManager] Download push notification error:', error);
  }
}

/** Ask the extension side to re-project its steady panel state (ordinary
 *  `pimote:panels` messages). Emitted when a client (re)claims a session or the
 *  session state is reset: pimote's panel snapshot is in-memory and can be empty
 *  or stale after a restart, and extension repaints are otherwise driven by state
 *  transitions. Fire-and-forget; extensions that don't know the channel ignore it. */
export function requestSlotPanelResync(slot: ManagedSlot, reason: 'claim' | 'reset'): void {
  slot.eventBusRef.current?.emit('pimote:panels:sync', { reason });
}

/**
 * Create command-context actions for extension commands.
 *
 * Runtime replacement methods invoke the manager's rebind callback inside Pi's
 * replacement seam before Pi runs any optional withSession callback.
 */
/** @internal Exported for the SDK delegation contract test. */
export function createCommandContextActions(slot: ManagedSlot, sessionManager: PimoteSessionManager): ExtensionCommandContextActions {
  return {
    waitForIdle: () => slot.session.waitForIdle(),
    newSession: async (options) => {
      const result = await runSlotLifecycle(slot, 'reset', () => slot.runtime.newSession(options));
      return { cancelled: result.cancelled };
    },
    fork: async (entryId, options) => {
      const result = await runSlotLifecycle(slot, 'reset', () => slot.runtime.fork(entryId, options));
      return { cancelled: result.cancelled };
    },
    navigateTree: async (targetId, options) =>
      runSlotLifecycle(slot, 'reset', async () => {
        const result = await slot.session.navigateTree(targetId, options);
        if (!result.cancelled) await sessionManager.applySessionReset(slot);
        return { cancelled: result.cancelled };
      }),
    switchSession: async (sessionPath, options) => {
      const result = await runSlotLifecycle(slot, 'reset', () => slot.runtime.switchSession(sessionPath, options));
      return { cancelled: result.cancelled };
    },
    reload: () => slot.session.reload(),
  };
}

// ---- Slot-based session state lifecycle helpers ----

/** Construct a SessionState from an AgentSession and EventBus.
 *  Subscribes to session events and sets up panel listeners. */
/** @internal Exported for lifecycle contract tests. */
export function createSessionState(
  session: AgentSession,
  eventBus: EventBusController,
  config: PimoteConfig,
  callbacks: {
    onStatusChange?: (sessionId: string, folderPath: string) => void;
    onSessionIdle?: (sessionId: string, slot: ManagedSlot) => void;
    sendEvent: (event: PimoteEvent) => void;
    notify: (payload: PushNotificationPayload) => Promise<void>;
  },
  slotRef: { slot: ManagedSlot | null },
  folderPath: string,
): SessionState {
  const sessionId = session.sessionId;
  // Wall-clock base: a recreated slot's cursors sit above every cursor its
  // predecessor handed out (at most 1000 events per millisecond of lifetime),
  // so a client's stale cursor replays as stale instead of as caught up.
  const visibility = rendererRegisteredVisibility(session);
  const eventBuffer = new EventBuffer(config.bufferSize, visibility, Date.now() * 1000, () => extractMessageEntryIds(session.sessionManager.getBranch(), visibility));

  const state: SessionState = {
    id: sessionId,
    eventBuffer,
    status: session.isStreaming ? 'working' : 'idle',
    needsAttention: false,
    idleSince: session.isStreaming ? null : Date.now(),
    unsubscribe: () => {},
    pendingUiResponses: new Map(),
    extensionsBound: false,
    sessionIdentity: session,
    panelState: new Map(),
    downloads: [],
    downloadListenerUnsub: undefined,
    panelListenerUnsubs: [],
    panelThrottleTimer: null,
    treeNavigationInProgress: false,
    bashDispatchInProgress: false,
    bashAbortRequested: false,
    queueOwnership: new QueueOwnership(),
  };

  // Subscribe to session events
  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'queue_update') {
      for (const kind of QUEUE_KINDS) state.queueOwnership.syncFromPi(kind, event[kind]);
    }
    if (event.type === 'agent_start' && state.status !== 'working') {
      state.status = 'working';
      state.idleSince = null;
      callbacks.onStatusChange?.(sessionId, folderPath);
    } else if (event.type === 'session_info_changed') {
      // Session names are part of the sidebar/session metadata snapshot rather
      // than a streamed conversation event. Broadcast that snapshot immediately
      // so the active title and folder session row both stay current.
      callbacks.onStatusChange?.(sessionId, folderPath);
    } else if (event.type === 'agent_settled' && state.status !== 'idle') {
      // Authoritative idle boundary: raised only when the session is genuinely
      // quiescent (no active run, retry, auto-compaction, or queued
      // continuation). Driving the completion push + idle-reap clock off this
      // rather than the terminal `agent_end` avoids a premature "done" push /
      // reap when a queued follow-up continues the session after `agent_end`.
      state.status = 'idle';
      state.idleSince = Date.now();
      state.needsAttention = true;
      // Nothing queued can still arrive from an idle session. Drop unconsumed intents.
      state.queueOwnership.clearIntents();
      // A user-aborted run does not warrant a completion push: whoever
      // aborted it is already engaged with the session.
      if (!event.aborted && slotRef.slot) callbacks.onSessionIdle?.(sessionId, slotRef.slot);
      callbacks.onStatusChange?.(sessionId, folderPath);
    }
    eventBuffer.onEvent(
      event,
      sessionId,
      (e) => callbacks.sendEvent(e),
      () => session.messages[session.messages.length - 1],
    );
  });

  state.unsubscribe = unsubscribe;

  // Bind feature EventBus listeners after the state holder exists.
  state.panelListenerUnsubs = setupSlotPanelListeners(eventBus, state, sessionId, callbacks.sendEvent);
  state.panelListenerUnsubs.push(eventBus.on(SETTINGS_CHANGED_CHANNEL, () => callbacks.sendEvent(makeSessionSettingsEvent(sessionId, session))));
  state.downloadListenerUnsub = setupSlotDownloadListener(eventBus, {
    sessionId,
    folderPath,
    sessionName: session.sessionName,
    state,
    send: callbacks.sendEvent,
    notify: callbacks.notify,
  });

  return state;
}

/** Clean up a SessionState: resolve pending UI, clear timers, unsubscribe listeners. */
function teardownSessionState(state: SessionState): void {
  // Resolve all pending UI responses
  for (const [, pending] of state.pendingUiResponses) {
    pending.resolve(undefined);
  }
  state.pendingUiResponses.clear();

  // Clear panel throttle timer
  if (state.panelThrottleTimer) clearTimeout(state.panelThrottleTimer);

  // Remove feature EventBus listeners.
  state.downloadListenerUnsub?.();
  state.downloadListenerUnsub = undefined;
  for (const unsub of state.panelListenerUnsubs) unsub();
  state.panelListenerUnsubs = [];

  // Unsubscribe from session events
  state.unsubscribe();
}

/** EventBus channel on which the settings watcher reports model and thinking-level changes. */
const SETTINGS_CHANGED_CHANNEL = 'pimote:settings-changed';

/** Snapshot of a session's settings, as observers render them. */
export function makeSessionSettingsEvent(sessionId: string, session: AgentSession): SessionSettingsChangedEvent {
  const model = session.model;
  return {
    type: 'session_settings_changed',
    sessionId,
    model: model ? { provider: model.provider, id: model.id, name: model.name } : null,
    thinkingLevel: session.thinkingLevel,
    availableThinkingLevels: session.getAvailableThinkingLevels(),
    autoCompactionEnabled: session.autoCompactionEnabled,
  };
}

/**
 * Report model and thinking-level changes from every source (pimote commands,
 * slash commands, extensions, pi's own clamping) on the session EventBus, so
 * every observer renders current settings. pi emits no session event for a
 * model change; only extensions see `model_select`.
 */
export function createSettingsWatchExtension(): ExtensionFactory {
  return (pi) => {
    const report = () => {
      pi.events.emit(SETTINGS_CHANGED_CHANNEL, undefined);
    };
    pi.on('model_select', report);
    pi.on('thinking_level_select', report);
  };
}

/** Register panel detection and data listeners for a SessionState on an EventBus. */
function setupSlotPanelListeners(eventBus: EventBusController, state: SessionState, sessionId: string, sendEvent: (event: PimoteEvent) => void): (() => void)[] {
  const unsub1 = eventBus.on('pimote:detect:request', () => {
    eventBus.emit('pimote:detect:response', { detected: true });
  });
  const unsub2 = eventBus.on('pimote:panels', (data) => {
    if (applyPanelMessage(state.panelState, data)) scheduleSlotPanelPush(state, sessionId, sendEvent);
  });
  const unsub3 = eventBus.on('pimote:navigate', (data) => {
    const url = (data as { url?: unknown } | null | undefined)?.url;
    if (typeof url !== 'string' || url.length === 0) return;
    sendEvent({ type: 'pimote_navigate', sessionId, url });
  });
  return [unsub1, unsub2, unsub3];
}

/** Schedule a throttled panel push (~200ms) for a SessionState. */
function scheduleSlotPanelPush(state: SessionState, sessionId: string, sendEvent: (event: PimoteEvent) => void): void {
  if (state.panelThrottleTimer !== null) return;
  state.panelThrottleTimer = setTimeout(() => {
    state.panelThrottleTimer = null;
    try {
      const cards = getMergedPanelCards(state.panelState);
      sendEvent({ type: 'panel_update', sessionId, cards });
    } catch (error) {
      console.error('[SessionManager] Panel update error:', error);
    }
  }, 200);
}

/**
 * Coalesce concurrent async operations keyed by `key`: while one is in flight,
 * callers passing the same key share its promise instead of starting a second
 * run. The map entry is cleared once the operation settles, so a later call
 * with the same key runs fresh.
 */
export async function singleFlight<V>(map: Map<string, Promise<V>>, key: string, run: () => Promise<V>): Promise<V> {
  const inflight = map.get(key);
  if (inflight) return inflight;
  const p = run().finally(() => {
    map.delete(key);
  });
  map.set(key, p);
  return p;
}

export class PimoteSessionManager {
  private readonly loginOrchestrator: LoginOrchestrator;
  private readonly sessions = new Map<string, ManagedSlot>();
  /** In-flight `openSession` promises keyed by session file path, so two
   *  concurrent opens of the same on-disk session share one runtime instead
   *  of building (and leaking) a second one over the same file. */
  private readonly inFlightOpens = new Map<string, Promise<string>>();
  /** Lifecycle locks keyed by stable session id. Archive, resume, and open
   *  callers use this seam so metadata and live-slot transitions cannot cross
   *  each other halfway through an operation. */
  private readonly sessionOperationLocks = new Map<string, Promise<unknown>>();
  /** Coalesce asynchronous extension startup per concrete AgentSession. */
  private readonly extensionBindFlights = new WeakMap<AgentSession, Promise<void>>();
  private idleCheckHandle: ReturnType<typeof setInterval> | null = null;
  private gitBranchCheckHandle: ReturnType<typeof setInterval> | null = null;
  /** Call-active predicate from the latest startIdleCheck; an active voice
   *  call protects a slot from an explicit close-at request too. */
  private callActiveCheck?: (sessionId: string) => boolean;
  private lastKnownGitBranchBySession = new Map<string, string | null>();

  onStatusChange?: (sessionId: string, folderPath: string) => void;
  onSessionClosed?: (sessionId: string, folderPath: string) => void;
  onGitBranchChange?: (sessionId: string, folderPath: string) => void;
  /** Fired synchronously before a session's state is torn down (e.g. idle
   *  reap, explicit close). Consumers use this to drop external bookkeeping
   *  (e.g. `VoiceOrchestrator.endCall`) while the session is still addressable. */
  onBeforeSessionClose?: (sessionId: string, folderPath: string) => Promise<void> | void;
  /** Fired when a re-key collision evicts the slot currently holding the target
   *  session ID, BEFORE that slot is closed. Consumers notify every observer of
   *  the evicted slot while it is still addressable via getSlot. */
  onSlotEvicted?: (sessionId: string) => void;
  /** Fired once per concrete re-key, after the slot's maps are re-keyed and
   *  before observers are notified — even when the slot has no observers.
   *  `observerClientIds` names the connections about to receive
   *  session_replaced (they apply the swap locally, so profile broadcasts can
   *  skip them). */
  onSlotRekeyed?: (oldId: string, newId: string, folderPath: string, observerClientIds: ReadonlySet<string>) => Promise<void> | void;

  private readonly staticHostFactory?: ExtensionFactory;
  private readonly fileDownloadFactory?: ExtensionFactory;
  private readonly managerExtensionFactory?: ExtensionFactory;
  private readonly pimoteDocsFactory?: ExtensionFactory;
  private readonly isVoiceModeActive?: (slot: ManagedSlot) => boolean;
  private readonly subagentReconnectGraceMs: number;
  private readonly configSupplier: () => PimoteConfig;

  private constructor(
    private readonly config: PimoteConfig,
    private readonly pushNotificationService: PushNotificationService,
    private readonly modelRuntime: ModelRuntime,
    options: SessionManagerOptions = {},
  ) {
    // Login stays server-global and shares the exact runtime every session uses.
    this.loginOrchestrator = new LoginOrchestrator(this.modelRuntime);
    this.staticHostFactory = options.staticHostFactory;
    this.fileDownloadFactory = options.fileDownloadFactory;
    this.managerExtensionFactory = options.managerExtensionFactory;
    this.pimoteDocsFactory = options.pimoteDocsFactory;
    this.isVoiceModeActive = options.isVoiceModeActive;
    this.subagentReconnectGraceMs = Math.max(0, options.subagentReconnectGraceMs ?? 15_000);
    this.configSupplier = options.configSupplier ?? (() => this.config);
  }

  /** Return the effective configuration for a new session or extension. */
  private currentConfig(): PimoteConfig {
    return this.configSupplier();
  }

  /** Initialize the one process-lifetime Pi model/auth runtime before serving sessions. */
  static async create(config: PimoteConfig, pushNotificationService: PushNotificationService, options: SessionManagerOptions = {}): Promise<PimoteSessionManager> {
    const modelRuntime = await ModelRuntime.create();
    return new PimoteSessionManager(config, pushNotificationService, modelRuntime, options);
  }

  /**
   * Build the voice extension factory for this server's config, if possible.
   * Returns undefined when voice is not configured (no speechmux URLs) or
   * when neither voice-specific model refs nor fallback defaultProvider/
   * defaultModel are configured. Non-voice deployments continue to work
   * unchanged — sessions simply don't load `@pimote/voice` at all.
   */
  private buildVoiceExtensionFactory(getSession: () => AgentSession): ExtensionFactory | undefined {
    const config = this.currentConfig();
    // Voice transport is startup-only. Model defaults are read for each new
    // voice extension so a native-config reload affects future consumers.
    if (!this.config.voice?.speechmuxSignalUrl || !this.config.voice?.speechmuxLlmWsUrl) {
      return undefined;
    }
    const interpreter = config.defaultInterpreterModel ?? (config.defaultProvider && config.defaultModel ? `${config.defaultProvider}/${config.defaultModel}` : undefined);
    const worker = config.defaultWorkerModel ?? (config.defaultProvider && config.defaultModel ? `${config.defaultProvider}/${config.defaultModel}` : undefined);
    if (!interpreter || !worker) {
      console.warn('[pimote] voice extension disabled: no defaultInterpreterModel/defaultWorkerModel or fallback defaultProvider/defaultModel in config');
      return undefined;
    }
    return createVoiceExtension({
      defaultInterpreterModel: interpreter,
      defaultWorkerModel: worker,
      getSession,
    });
  }

  /**
   * Open (or reopen) a session, returning its id.
   *
   * For an existing on-disk session (`sessionFilePath` provided), this guards
   * against ever binding a SECOND pi runtime to the same session file: it
   * returns the already-open session's id when it's live in memory, and
   * coalesces concurrent opens of the same file into a single runtime. Without
   * this, a reconnect double-fire or two devices opening the same session race
   * between the (miss) existence check and the eventual `sessions.set`, spawn
   * two runtimes appending to one file (corrupting history), and leak the
   * first. New sessions (no file) create a fresh file each time, so they need
   * no coalescing.
   */
  async openSession(folderPath: string, sessionFilePath?: string): Promise<string> {
    if (!sessionFilePath) {
      return this.doOpenSession(folderPath);
    }
    const inFlight = this.inFlightOpens.get(sessionFilePath);
    if (inFlight) return inFlight;
    const alreadyOpenId = this.findSlotIdBySessionFile(sessionFilePath);
    if (alreadyOpenId) {
      const slot = this.sessions.get(alreadyOpenId);
      if (slot) await this.ensureExtensionsBound(slot);
      return alreadyOpenId;
    }
    return singleFlight(this.inFlightOpens, sessionFilePath, () => this.doOpenSession(folderPath, sessionFilePath));
  }

  /** Serialize metadata and runtime lifecycle changes for one stable session
   *  id. Callers keep lookup, archive checks, opens, and closes inside this
   *  operation so an archive cannot close a slot that a resume just opened. */
  withSessionOperation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionOperationLocks.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const settled = current.finally(() => {
      if (this.sessionOperationLocks.get(sessionId) === settled) this.sessionOperationLocks.delete(sessionId);
    });
    this.sessionOperationLocks.set(sessionId, settled);
    return settled;
  }

  /** Find the id of an open slot bound to the given session file, if any. */
  private findSlotIdBySessionFile(sessionFilePath: string): string | undefined {
    for (const [sid, slot] of this.sessions) {
      if (slot.session.sessionFile === sessionFilePath) return sid;
    }
    return undefined;
  }

  /** Find the current map key for one slot by object identity. */
  private findMapKeyForSlot(slot: ManagedSlot): string | undefined {
    for (const [sessionId, candidate] of this.sessions) {
      if (candidate === slot) return sessionId;
    }
    return undefined;
  }

  /**
   * Bind one concrete AgentSession exactly once. The flight is keyed by object
   * identity because a replacement can reuse its predecessor's session ID.
   */
  private async cleanupFailedReset(slot: ManagedSlot): Promise<void> {
    const currentId = this.findMapKeyForSlot(slot);
    if (currentId === undefined) return;
    await this.closeSession(currentId);
  }

  /** Build the narrow Pimote capability adapter used by a child surface. */
  private childSurfaceCapabilities(session: BorrowedAgentSession): SessionSurfaceCapabilities {
    const native = session as BorrowedAgentSession & {
      modelRuntime?: { getAvailable?: () => Promise<readonly unknown[]> | readonly unknown[] };
      getAvailableThinkingLevels?: () => readonly string[];
      autoCompactionEnabled?: boolean;
      sessionName?: string;
      executeBash?: (command: string, context?: unknown, options?: unknown) => Promise<unknown>;
    };
    return {
      resolveModel: async (provider, modelId) => {
        const models = (await native.modelRuntime?.getAvailable?.()) ?? [];
        return models.find((candidate) => {
          if (!candidate || typeof candidate !== 'object') return false;
          const value = candidate as { provider?: unknown; id?: unknown };
          return value.provider === provider && value.id === modelId;
        }) as Awaited<ReturnType<SessionSurfaceCapabilities['resolveModel']>>;
      },
      getSettings: () => ({
        availableThinkingLevels: [...(native.getAvailableThinkingLevels?.() ?? [])],
        autoCompactionEnabled: native.autoCompactionEnabled === true,
        ...(typeof native.sessionName === 'string' ? { sessionName: native.sessionName } : {}),
      }),
      getCommands: async () => [],
      completeArgs: async () => [],
      completeFileRefs: async () => [],
      executeBash: async (command, options) => {
        if (!native.executeBash) throw new Error('native bash is not available');
        return native.executeBash(command, undefined, options);
      },
      getGitBranch: () => null,
    };
  }

  /** Create a root host without adding child runtimes to this manager's slots. */
  private createSubagentHostForSlot(slot: ManagedSlot, provider: SubagentProvider): SubagentHost {
    const parentSurface = createSessionSurface({
      sessionId: slot.session.sessionId,
      session: slot.session as unknown as BorrowedAgentSession,
      kind: 'root',
    });
    return createSubagentHost({
      rootSessionId: slot.sessionState.id,
      provider,
      parentSurface,
      parentCursor: () => slot.sessionState.eventBuffer.currentCursor,
      emitParentEvent: (event) => {
        slot.sessionState.eventBuffer.appendSemanticEvent(event, slot.sessionState.id, (mapped) => sendSlotEvent(slot, mapped));
      },
      emitViewChange: (connectionId, change, incarnation, viewCursor) => {
        slot.subagentViewListeners?.get(connectionId)?.(change, incarnation, viewCursor);
      },
      reconnectGraceMs: this.subagentReconnectGraceMs,
      childCapabilities: (session) => this.childSurfaceCapabilities(session),
    });
  }

  private sendSubagentSnapshotToObservers(slot: ManagedSlot, snapshot: SubagentSnapshot): void {
    sendSlotEvent(slot, {
      type: 'subagent_snapshot',
      sessionId: slot.sessionState.id,
      ...snapshot,
    });
  }

  /** Replace one root's provider host while keeping the root slot stable. */
  private async replaceSubagentProvider(slot: ManagedSlot, provider: SubagentProvider): Promise<void> {
    if (slot.subagentClosed || this.findMapKeyForSlot(slot) === undefined) return;
    if (slot.subagentProvider === provider && slot.subagentHost) return;
    const hadHost = slot.subagentHost !== undefined;
    await this.shutdownSubagentHost(slot, 'replaced');
    if (slot.subagentClosed || this.findMapKeyForSlot(slot) === undefined) return;
    const host = this.createSubagentHostForSlot(slot, provider);
    slot.subagentProvider = provider;
    slot.subagentHost = host;
    const started = await host.start();
    if (slot.subagentClosed || this.findMapKeyForSlot(slot) === undefined || slot.subagentHost !== host) {
      await host.shutdown();
      return;
    }
    if (hadHost) {
      await Promise.all([...slot.observers.values()].map((observer) => observer.onSessionReset?.(slot, { kind: 'unchanged' })));
    } else {
      this.sendSubagentSnapshotToObservers(slot, started.snapshot);
    }
  }

  /** Dispose a host, but keep the discovery listener alive for replacement. */
  private async shutdownSubagentHost(slot: ManagedSlot, reason: 'replaced' | 'unavailable' = 'unavailable'): Promise<void> {
    const host = slot.subagentHost;
    slot.subagentHost = undefined;
    slot.subagentProvider = undefined;
    if (!host) return;
    await host.shutdown(reason);
  }

  /** Close discovery and the provider host at a root lifecycle boundary. */
  private async shutdownSubagentIntegration(slot: ManagedSlot, reason: 'replaced' | 'unavailable' = 'unavailable'): Promise<void> {
    slot.subagentClosed = true;
    slot.subagentDiscoveryUnsubscribe?.();
    slot.subagentDiscoveryUnsubscribe = undefined;
    slot.subagentDiscovery?.close();
    slot.subagentDiscovery = undefined;
    slot.subagentDiscoveryBus = undefined;
    await slot.subagentTransition?.catch(() => undefined);
    slot.subagentTransition = undefined;
    await this.shutdownSubagentHost(slot, reason);
  }

  /** Install discovery before extension binding so session_start registration is observed. */
  private prepareSubagentDiscovery(slot: ManagedSlot): void {
    const eventBus = slot.eventBusRef.current;
    if (!eventBus) return;
    if (slot.subagentDiscovery && slot.subagentDiscoveryBus === eventBus) return;
    slot.subagentDiscoveryUnsubscribe?.();
    slot.subagentDiscovery?.close();
    slot.subagentDiscoveryUnsubscribe = undefined;
    slot.subagentDiscoveryBus = eventBus;
    slot.subagentClosed = false;
    const discovery = discoverProvider(eventBus);
    slot.subagentDiscovery = discovery;
    slot.subagentDiscoveryUnsubscribe = discovery.subscribe((provider) => {
      if (!provider || slot.subagentClosed) return;
      const previous = slot.subagentTransition ?? Promise.resolve();
      const transition = previous.catch(() => undefined).then(() => this.replaceSubagentProvider(slot, provider));
      slot.subagentTransition = transition;
      void transition.catch((error) => {
        console.error('[SessionManager] Subagent provider host error:', error);
      });
    });
  }

  private async ensureExtensionsBound(slot: ManagedSlot): Promise<void> {
    this.prepareSubagentDiscovery(slot);
    if (this.findMapKeyForSlot(slot) === undefined) throw new Error('Session slot is no longer live');
    const session = slot.session;
    const state = slot.sessionState;
    if (state.extensionsBound && state.sessionIdentity === session) {
      await slot.subagentTransition;
      return;
    }

    const existing = this.extensionBindFlights.get(session);
    if (existing) {
      await existing;
      if (slot.session === session && slot.sessionState === state && state.extensionsBound && state.sessionIdentity === session) {
        await slot.subagentTransition;
        return;
      }
      return this.ensureExtensionsBound(slot);
    }

    const bind = Promise.resolve().then(async () => {
      const uiContext = createExtensionUIBridge(slot, this.pushNotificationService, {
        isVoiceModeActive: () => this.isVoiceModeActive?.(slot) ?? false,
      });
      const commandContextActions = createCommandContextActions(slot, this);
      await session.bindExtensions({ uiContext, commandContextActions });
      // A session_start handler can synchronously trigger a replacement. Do
      // not mark the old state as bound after that replacement wins the slot.
      if (this.findMapKeyForSlot(slot) === undefined || slot.session !== session || slot.sessionState !== state) return;
      state.extensionsBound = true;
      state.sessionIdentity = session;
      await slot.subagentTransition;
    });
    this.extensionBindFlights.set(session, bind);
    try {
      await bind;
    } finally {
      if (this.extensionBindFlights.get(session) === bind) this.extensionBindFlights.delete(session);
    }
  }

  private async doOpenSession(folderPath: string, sessionFilePath?: string): Promise<string> {
    const eventBusRef: { current: EventBusController | null } = { current: null };
    const sharedModelRuntime = this.modelRuntime;
    const sessionManager = sessionFilePath ? PiSessionManager.open(sessionFilePath) : PiSessionManager.create(folderPath);
    const effectiveFolderPath = sessionFilePath ? sessionManager.getCwd() : folderPath;

    const staticHostFactory = this.staticHostFactory;
    const fileDownloadFactory = this.fileDownloadFactory;
    const managerExtensionFactory = this.managerExtensionFactory;
    const pimoteDocsFactory = this.pimoteDocsFactory;

    const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
      // Services load extension factories before constructing AgentSession.
      // Bind this explicit per-runtime holder before session_start is emitted
      // by bindExtensions; replacement runtimes get a fresh holder/factory.
      const voiceSessionRef: { current: AgentSession | null } = { current: null };
      const previousEventBus = eventBusRef.current;
      let createdSession: AgentSession | undefined;
      try {
        const voiceExtensionFactory = this.buildVoiceExtensionFactory(() => {
          if (!voiceSessionRef.current) throw new Error('Voice session is not bound yet');
          return voiceSessionRef.current;
        });
        const extensionFactories = [
          ...(voiceExtensionFactory ? [voiceExtensionFactory] : []),
          ...(pimoteDocsFactory ? [pimoteDocsFactory] : []),
          ...(staticHostFactory ? [staticHostFactory] : []),
          ...(fileDownloadFactory ? [fileDownloadFactory] : []),
          ...(managerExtensionFactory && (await loadManagerExtension({ cwd }, this.config)) ? [managerExtensionFactory] : []),
          // SDK sessions skip pi's built-in extensions, so register Pi's
          // codemode, tool-search, and MCP extensions here. Codemode and
          // tool-search stay inactive until settings or MCP exposure activates
          // them; MCP reads Pi's mcp.json configuration at session start.
          createCodemodeExtension(),
          createToolSearchExtension(),
          createMcpExtension(),
          createSettingsWatchExtension(),
        ];
        const eventBus = createEventBus();
        eventBusRef.current = eventBus;

        const services = await createAgentSessionServices({
          cwd,
          agentDir,
          modelRuntime: sharedModelRuntime,
          resourceLoaderOptions: {
            eventBus,
            ...(extensionFactories.length ? { extensionFactories } : {}),
          },
        });

        const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent });
        createdSession = result.session;
        voiceSessionRef.current = result.session;
        return {
          ...result,
          services,
          diagnostics: services.diagnostics,
        };
      } catch (error) {
        // AgentSessionRuntime does not own a result until its factory resolves.
        // Dispose a session created before a later factory step failed so a
        // replacement cannot leave extension listeners and MCP resources live.
        eventBusRef.current?.clear();
        if (previousEventBus && previousEventBus !== eventBusRef.current) previousEventBus.clear();
        if (createdSession) {
          try {
            createdSession.dispose();
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'Session runtime factory and cleanup failed', { cause: cleanupError });
          }
        }
        throw error;
      }
    };

    const runtime = await createAgentSessionRuntime(factory, {
      cwd: effectiveFolderPath,
      agentDir: getAgentDir(),
      sessionManager,
    });

    const session = runtime.session;
    const sessionId = session.sessionId;

    // Diagnostics: log model runtime state after factory has loaded extensions
    const availableModels = await this.modelRuntime.getAvailable();
    console.log(`[pimote] openSession: ${availableModels.length} models available, session model: ${session.model ? `${session.model.provider}/${session.model.id}` : 'none'}`);

    // Apply default model from config (only for new sessions without an existing model preference)
    const currentConfig = this.currentConfig();
    // Apply defaults only to newly-created sessions. Existing sessions retain
    // their persisted model and thinking settings.
    if (!sessionFilePath && currentConfig.defaultProvider && currentConfig.defaultModel) {
      const models = await this.modelRuntime.getAvailable();
      const defaultModel = models.find((m) => m.provider === currentConfig.defaultProvider && m.id === currentConfig.defaultModel);
      if (defaultModel) {
        await session.setModel(defaultModel);
        console.log(`[pimote] Set default model: ${defaultModel.provider}/${defaultModel.id}`);
      } else {
        console.warn(`[pimote] Default model not found: ${currentConfig.defaultProvider}/${currentConfig.defaultModel}`);
      }
    }

    // Apply default thinking level from config
    if (!sessionFilePath && currentConfig.defaultThinkingLevel) {
      session.setThinkingLevel(currentConfig.defaultThinkingLevel as AgentSession['thinkingLevel']);
      console.log(`[pimote] Set default thinking level: ${currentConfig.defaultThinkingLevel}`);
    }

    // Pimote convention: drain the entire steering / follow-up queue into a
    // single consolidated run rather than one message per run. Matches the
    // UX expectation that queued messages are delivered together when the
    // agent next processes, not metered out across multiple turns.
    session.setSteeringMode('all');
    session.setFollowUpMode('all');

    // Create the slot object. Use a slotRef so createSessionState callbacks can reference the slot.
    const slotRef: { slot: ManagedSlot | null } = { slot: null };
    let slot!: ManagedSlot;
    try {
      const sessionState = createSessionState(
        session,
        eventBusRef.current!,
        this.currentConfig(),
        {
          onStatusChange: (sid, fp) => this.onStatusChange?.(sid, fp),
          onSessionIdle: (sid, s) => this.handleSessionIdle(sid, s),
          sendEvent: (e) => sendSlotEvent(slot, e),
          notify: (payload) => this.pushNotificationService.notify(payload),
        },
        slotRef,
        effectiveFolderPath,
      );

      slot = {
        runtime,
        folderPath: effectiveFolderPath,
        eventBusRef,
        observers: new Map(),
        sessionState,
        subagentViewListeners: new Map(),
        subagentClosed: false,
        get session() {
          return this.runtime.session;
        },
      };
      slot.runtime = guardSlotRuntime(slot, runtime, (failedSlot) => this.cleanupFailedReset(failedSlot));
      slotRef.slot = slot;
    } catch (error) {
      try {
        await runtime.dispose();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Session state creation and cleanup failed', { cause: cleanupError });
      }
      throw error;
    }

    // Publish the live slot before startup so extension session_start handlers
    // can resolve it through manager-owned buses. Failure rolls back through
    // the same runtime disposal path as an ordinary close.
    this.sessions.set(sessionId, slot);
    try {
      runtime.setRebindSession(async () => {
        await this.handleRuntimeSessionReplacement(slot);
      });
      await this.ensureExtensionsBound(slot);
      const liveSessionId = slot.sessionState.id;
      this.lastKnownGitBranchBySession.set(liveSessionId, await getGitBranch(slot.folderPath));
      return liveSessionId;
    } catch (error) {
      try {
        const liveSessionId = this.findMapKeyForSlot(slot);
        if (liveSessionId !== undefined) {
          await this.closeSession(liveSessionId);
        } else {
          await slot.runtime.dispose();
        }
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Session opening and cleanup failed', { cause: cleanupError });
      }
      throw error;
    }
  }

  private handleSessionIdle(sessionId: string, slot: ManagedSlot): void {
    const folderPath = slot.folderPath;
    const projectName = folderPath.split('/').pop() ?? 'Unknown';
    const firstMessage = this.extractFirstMessage(slot);
    const lastAgentMessage = this.extractLastAgentMessage(slot);
    this.pushNotificationService
      .notify({
        projectName,
        folderPath,
        sessionId,
        sessionName: slot.session.sessionName,
        firstMessage,
        reason: 'idle',
        lastAgentMessage,
      })
      .catch((err) => console.error('[SessionManager] Push notification error:', err));
  }

  private extractLastAgentMessage(slot: ManagedSlot): string | undefined {
    const messages = slot.session.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== 'assistant') continue;
      const text = msg.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('');
      if (text) return text.slice(0, 200);
      break;
    }
    return undefined;
  }

  private extractFirstMessage(slot: ManagedSlot): string | undefined {
    const messages = slot.session.messages ?? [];
    for (const msg of messages) {
      if (msg.role !== 'user') continue;
      const { content } = msg;
      if (typeof content === 'string') return content.slice(0, 100);
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c.type === 'text') return c.text.slice(0, 100);
        }
      }
      break;
    }
    return undefined;
  }

  async closeSession(sessionId: string): Promise<void> {
    const slot = this.sessions.get(sessionId);
    if (!slot) return;

    await runSlotLifecycle(slot, 'close', async () => {
      if (this.onBeforeSessionClose) {
        try {
          await this.onBeforeSessionClose(sessionId, slot.folderPath);
        } catch (err) {
          console.warn('[pimote] onBeforeSessionClose threw:', err);
        }
      }

      await this.shutdownSubagentIntegration(slot);
      slot.subagentViewListeners?.clear();
      teardownSessionState(slot.sessionState);
      slot.eventBusRef.current?.clear();

      const folderPath = slot.folderPath;
      let disposeError: unknown;
      try {
        await slot.runtime.dispose();
      } catch (error) {
        disposeError = error;
      }
      if (this.sessions.get(sessionId) === slot) {
        this.sessions.delete(sessionId);
        this.lastKnownGitBranchBySession.delete(sessionId);
      }

      this.onSessionClosed?.(sessionId, folderPath);
      if (disposeError !== undefined) throw disposeError;
    });
  }

  /** Re-key a slot in the session map after session replacement. */
  reKeySession(slot: ManagedSlot, oldId: string, newId: string): void {
    this.sessions.delete(oldId);
    this.sessions.set(newId, slot);

    const lastKnown = this.lastKnownGitBranchBySession.get(oldId) ?? null;
    this.lastKnownGitBranchBySession.delete(oldId);
    this.lastKnownGitBranchBySession.set(newId, lastKnown);
  }

  /** Sync read of the cached git branch for a session. Refreshed every 3s by the
   *  branch-check poll and seeded on open, so hot paths (sidebar broadcasts,
   *  get_session_meta) read this instead of shelling out to git on the event loop.
   *  May be up to ~3s stale; branch changes are rare so this is invisible in practice. */
  getLastKnownGitBranch(sessionId: string): string | null {
    return this.lastKnownGitBranchBySession.get(sessionId) ?? null;
  }

  /** Reconcile a runtime replacement before observers are notified. */
  private async reconcileSessionReplacement(slot: ManagedSlot): Promise<{
    observers: SessionObserver[];
    outcome: SessionResetOutcome;
    needsBinding: boolean;
  }> {
    const newSession = slot.runtime.session;
    const newId = newSession.sessionId;
    const oldId = slot.sessionState.id;
    const observers = [...slot.observers.values()];
    const sessionChanged = slot.sessionState.sessionIdentity !== newSession;

    // navigateTree keeps the same AgentSession. It still emits the historical
    // unchanged reset notification, but it does not rebuild or bind anything.
    if (newId === oldId && !sessionChanged) {
      slot.sessionState.eventBuffer.invalidateReplay();
      return { observers, outcome: { kind: 'unchanged' }, needsBinding: false };
    }

    // Rebuild state for every concrete AgentSession replacement, even when its
    // generated session ID happens to be unchanged. Child leases belong to the
    // old runtime and must close before its EventBus is replaced.
    await this.shutdownSubagentIntegration(slot, 'replaced');
    this.rebuildSessionState(slot);

    // Collision: another live slot already holds newId. This happens when an
    // extension switches onto a session file that another slot already owns.
    const occupant = this.sessions.get(newId);
    if (occupant && occupant !== slot) {
      this.onSlotEvicted?.(newId);
      await this.closeSession(newId);
    }

    if (newId !== oldId) this.reKeySession(slot, oldId, newId);

    const outcome: SessionResetOutcome = newId === oldId ? { kind: 'unchanged' } : { kind: 'rekeyed', oldId, newId, folderPath: slot.folderPath };
    if (outcome.kind === 'rekeyed') {
      await this.onSlotRekeyed?.(outcome.oldId, outcome.newId, outcome.folderPath, new Set(observers.map((observer) => observer.clientId)));
    }
    return { observers, outcome, needsBinding: true };
  }

  private async notifySessionReset(slot: ManagedSlot, observers: SessionObserver[], outcome: SessionResetOutcome): Promise<void> {
    for (let index = 0; index < observers.length; index++) {
      const observer = observers[index];
      await observer.onSessionReset?.(slot, outcome, index === 0);
    }
  }

  /** Rebind, reconcile, and notify one runtime replacement. Pi invokes this
   * callback before a replacement operation's optional withSession callback. */
  private async handleRuntimeSessionReplacement(slot: ManagedSlot): Promise<void> {
    markRuntimeReplacementApplied(slot);
    await runSlotLifecycle(slot, 'reset', async () => {
      markRuntimeReplacementApplied(slot);
      try {
        const { observers, outcome, needsBinding } = await this.reconcileSessionReplacement(slot);
        if (needsBinding) await this.ensureExtensionsBound(slot);
        await this.notifySessionReset(slot, observers, outcome);
      } catch (error) {
        const currentId = this.findMapKeyForSlot(slot);
        if (currentId !== undefined) {
          try {
            await this.closeSession(currentId);
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'Session replacement and cleanup failed', { cause: cleanupError });
          }
        }
        throw error;
      } finally {
        markCurrentRuntimePhase(slot, 'post');
      }
    });
  }

  /** The single reset business operation for same-session navigation.
   * Runtime replacements arrive through handleRuntimeSessionReplacement above,
   * so this method does not duplicate their observer notifications. */
  async applySessionReset(slot: ManagedSlot): Promise<void> {
    await runSlotLifecycle(
      slot,
      'reset',
      async () => {
        const previousPhase = setSlotLifecyclePhase(slot, 'binding');
        try {
          const { observers, outcome, needsBinding } = await this.reconcileSessionReplacement(slot);
          if (needsBinding) await this.ensureExtensionsBound(slot);
          await this.notifySessionReset(slot, observers, outcome);
        } finally {
          setSlotLifecyclePhase(slot, previousPhase ?? 'post');
        }
      },
      { allowPreparingNested: true },
    );
  }

  /** Rebuild a slot's SessionState after session replacement.
   *  Tears down the old state and creates a new one from the current runtime.session.
   *  Also refreshes slot.folderPath from the new session's header cwd, since fork-from
   *  (e.g. the worktree extension) can rebind the slot to a session whose cwd differs
   *  from the original. */
  rebuildSessionState(slot: ManagedSlot): void {
    teardownSessionState(slot.sessionState);

    const newCwd = slot.runtime.session.sessionManager.getCwd();
    if (newCwd) slot.folderPath = newCwd;

    const slotRef = { slot: slot as ManagedSlot | null };
    slot.sessionState = createSessionState(
      slot.runtime.session,
      slot.eventBusRef.current!,
      this.currentConfig(),
      {
        onStatusChange: (sid, fp) => this.onStatusChange?.(sid, fp),
        onSessionIdle: (sid, s) => this.handleSessionIdle(sid, s),
        sendEvent: (e) => sendSlotEvent(slot, e),
        notify: (payload) => this.pushNotificationService.notify(payload),
      },
      slotRef,
      slot.folderPath,
    );
  }

  /** Attach or replace one observer for a live session. */
  async attachObserver(sessionId: string, observer: SessionObserver): Promise<void> {
    const slot = this.sessions.get(sessionId);
    if (!slot) throw new Error(`Session not found: ${sessionId}`);
    slot.observers.set(observer.clientId, observer);
  }

  /** Detach one observer from a live session when it still owns this socket. */
  detachObserver(sessionId: string, clientId: string, ws?: EventSocket): void {
    const slot = this.sessions.get(sessionId);
    const observer = slot?.observers.get(clientId);
    if (!slot || !observer || (ws !== undefined && observer.ws !== ws)) return;
    slot.observers.delete(clientId);
  }

  /** Alias for getSession that returns null (not undefined) for consumers
   *  that expect nullable pointers (e.g. VoiceSessionBusResolver). */
  getSlot(sessionId: string): ManagedSlot | null {
    return this.sessions.get(sessionId) ?? null;
  }

  getSession(sessionId: string): ManagedSlot | undefined {
    return this.sessions.get(sessionId);
  }

  /** The shared, server-wide login orchestrator (login is global, not session-scoped). */
  getLoginOrchestrator(): LoginOrchestrator {
    return this.loginOrchestrator;
  }

  /** The process-lifetime model/auth runtime every session shares (manager sessions included). */
  getModelRuntime(): ModelRuntime {
    return this.modelRuntime;
  }

  getAllSessions(): ManagedSlot[] {
    return Array.from(this.sessions.values());
  }

  startIdleCheck(idleTimeout: number | (() => number), isCallActive?: (sessionId: string) => boolean): void {
    this.stopIdleCheck();
    this.callActiveCheck = isCallActive;
    const readIdleTimeout = typeof idleTimeout === 'function' ? idleTimeout : () => idleTimeout;

    this.idleCheckHandle = setInterval(() => {
      const effectiveIdleTimeout = readIdleTimeout();
      for (const [sessionId, candidate] of this.sessions) {
        this.withSessionOperation(sessionId, async () => {
          const slot = this.sessions.get(sessionId);
          if (slot !== candidate) return;
          if (this.isSlotBusy(slot, isCallActive?.(sessionId) === true)) return;
          // Only settled sessions reap; the busy rule already kept working slots.
          const idleSince = slot.sessionState.idleSince;
          if (idleSince === null || Date.now() - idleSince <= effectiveIdleTimeout) return;
          // Poll extensions only after the idle threshold.
          if (this.slotReportsActivity(slot)) return;
          await this.closeSession(sessionId);
        }).catch(() => {
          // Best-effort cleanup — swallow errors during idle reaping
        });
      }
    }, 60_000);

    this.gitBranchCheckHandle = setInterval(() => {
      // Snapshot connected sessions and refresh their branches in parallel. The
      // lookups are async (execFile) so the poll never blocks the event loop;
      // hot-path readers consume the cache via getLastKnownGitBranch.
      const connected = [...this.sessions].filter(([, slot]) => slot.observers.size > 0);
      void Promise.all(
        connected.map(async ([sessionId, slot]) => {
          const next = await getGitBranch(slot.folderPath);
          const prev = this.lastKnownGitBranchBySession.get(sessionId) ?? null;
          if (next !== prev) {
            this.lastKnownGitBranchBySession.set(sessionId, next);
            this.onGitBranchChange?.(sessionId, slot.folderPath);
          }
        }),
      );
    }, 3000);
  }

  /** The reaper's busy rule minus the idle wait: a slot with observers, a
   *  live call, bash in flight, tree navigation, or an unsettled run must not
   *  be closed. One lifecycle rule holds for the idle reaper and for explicit
   *  close-at requests alike. */
  private isSlotBusy(slot: ManagedSlot, isCallActive: boolean): boolean {
    return (
      slot.observers.size > 0 ||
      isCallActive ||
      slot.session.isBashRunning ||
      slot.sessionState.bashDispatchInProgress === true ||
      slot.sessionState.treeNavigationInProgress ||
      slot.sessionState.idleSince === null
    );
  }

  /** The SDK reap-guard poll: extensions reporting live background work hold
   *  the slot open. */
  private slotReportsActivity(slot: ManagedSlot): boolean {
    const activityBus = slot.eventBusRef.current;
    return activityBus !== null && askActivity(activityBus);
  }

  stopIdleCheck(): void {
    if (this.idleCheckHandle !== null) {
      clearInterval(this.idleCheckHandle);
      this.idleCheckHandle = null;
    }
    if (this.gitBranchCheckHandle !== null) {
      clearInterval(this.gitBranchCheckHandle);
      this.gitBranchCheckHandle = null;
    }
  }

  /**
   * Close idle, observerless session slots rooted at or below any requested
   * path, through the canonical close lifecycle, and return the requested
   * paths that still host a live slot. A working or observed slot, a slot
   * with an active call, bash, tree navigation, or reported background work,
   * and a slot whose close failed all count as still hosted — the caller
   * must fail closed. This is the idle reaper's rule applied immediately
   * instead of after the idle timeout; hub disband uses it to retire hub
   * sessions the way archiving does.
   */
  async closeIdleSessionsAt(paths: ReadonlyArray<string>): Promise<ReadonlyArray<string>> {
    const bases = paths.map((path) => resolve(path));
    const hosted = (folderPath: string) => bases.some((base) => isWithin(resolve(folderPath), base));
    const stillHosted = new Set<string>();
    const snapshot = [...this.sessions];
    await Promise.all(
      snapshot.map(async ([sessionId, candidate]) => {
        if (!hosted(candidate.folderPath)) return;
        await this.withSessionOperation(sessionId, async () => {
          const slot = this.sessions.get(sessionId);
          // The slot was replaced under us; the replacement occupies the same
          // folder and was never classified. Fail closed.
          if (slot !== candidate) {
            stillHosted.add(candidate.folderPath);
            return;
          }
          if (this.isSlotBusy(slot, this.callActiveCheck?.(sessionId) === true)) {
            stillHosted.add(slot.folderPath);
            return;
          }
          if (this.slotReportsActivity(slot)) {
            stillHosted.add(slot.folderPath);
            return;
          }
          try {
            await this.closeSession(sessionId);
          } catch {
            // A slot that refuses to close still hosts its folder.
            stillHosted.add(slot.folderPath);
          }
        }).catch(() => {
          stillHosted.add(candidate.folderPath);
        });
      }),
    );
    return paths.filter((requested) => [...stillHosted].some((folder) => isWithin(resolve(folder), resolve(requested))));
  }

  async dispose(): Promise<void> {
    this.stopIdleCheck();
    const sessionIds = Array.from(this.sessions.keys());
    await Promise.all(sessionIds.map((id) => this.closeSession(id)));
  }
}
