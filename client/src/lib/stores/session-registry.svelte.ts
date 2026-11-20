// SessionRegistry — Svelte 5 runes-based session state manager
//
// This class MUST live in a .svelte.ts file so the Svelte compiler can
// transform $state() runes on class fields into reactive getter/setter pairs.
// Svelte 5's $state() proxy only wraps plain objects and arrays — class
// instances are returned as-is. That means wrapping `new SessionRegistry()`
// with $state() does nothing. The runes must be on the individual fields.

import type {
  ReorderSessionsResponseData,
  PimoteEvent,
  PimoteCommand,
  PimoteResponse,
  PimoteAgentMessage,
  PimoteMessageContent,
  PimoteImageContent,
  PimoteUsage,
  PimoteUsageBreakdown,
  StreamingMessage,
  SessionState,
  SessionMeta,
  OpenSessionResponseData,
  BufferedEventsEvent,
  MessageStartEvent,
  MessageUpdateEvent,
  MessageEndEvent,
  CustomEntryEvent,
  ToolExecutionStartEvent,
  ToolExecutionUpdateEvent,
  ToolExecutionEndEvent,
  AgentSettledEvent,
  FullResyncEvent,
  TreeNavigationStartEvent,
  AgentEndEvent,
  AutoRetryEndEvent,
  SessionConflictEvent,
  SessionStateChangedEvent,
  SessionSettingsChangedEvent,
  SessionCommandsChangedEvent,
  SessionOpenedEvent,
  SessionRenamedEvent,
  SessionReplacedEvent,
  PanelUpdateEvent,
  DownloadItem,
  DownloadUpdateEvent,
  NavigateEvent,
  SessionRestoreEvent,
  Card,
  RestoreMode,
  BashResult,
  FolderInfo,
  BashExecutionUpdateEvent,
  CommandInfo,
  QueueUpdateEvent,
  QueuedDraftsRestoredEvent,
  AgentPath,
  FeedCursor,
  SubagentNodeSnapshot,
  SubagentSnapshot,
  SubagentSnapshotEvent,
  SubagentTopologyEvent as WireSubagentTopologyEvent,
  SubagentViewSnapshot,
  SubagentViewEvent,
  SubagentViewClosedEvent,
  UserOpenViewRef,
} from '@pimote/shared';

import { connection, isSessionNotFoundError } from './connection.svelte.js';
import { imageContentBlocksFromDataUrls } from '../image-content.js';
import { commandStore } from './command-store.svelte.js';
import { setEditorText } from './input-bar.svelte.js';
import { panelStore } from './panel-store.svelte.js';
import { downloadUi } from './download-ui.svelte.js';
import { coordinateDownloadUpdate } from '../download-coordinator.js';
import { followDecision, moveChipOrder, projectChipOrder, type UserSessionFacts } from './user-session-facts.js';
import { handleDownloadNotificationIntent, type DownloadNotificationIntent } from '../download-notification-intent.js';
import { getActiveSessions } from './persistence.js';
import { summarizeAssistantRowUsage, type ToolResultUsageIndex } from '../assistant-row-usage.js';
import {
  applySubagentContentEvent,
  applySubagentContentDeltaInPlace,
  applySubagentContentToStreaming,
  hydrateSubagentContent,
  projectMessage,
  isSubagentContentEvent,
  type SubagentContentEvent,
  type SubagentContentState,
} from '../subagent-content.js';

/** Maximum UTF-8 bytes retained from live bash deltas per execution. */
export const MAX_BASH_LIVE_OUTPUT_BYTES = 256 * 1024;

/** Upper bound for live tool partial output, so a chatty tool cannot grow the
 *  streamed string (and its render) without limit. The final tool result
 *  replaces it on completion. */
export const MAX_TOOL_PARTIAL_CHARS = 256 * 1024;

const bashTextEncoder = new TextEncoder();
export type SubagentPath = AgentPath;

/** Metadata needed to rebuild a saved child after its live node is gone. */
export interface SubagentResurrectionDraft {
  readonly savedSessionId?: string;
  readonly task?: string;
  readonly channels?: readonly string[];
  readonly model?: string;
}

/** Stable key used for attachment state. JSON preserves path segment identity. */
export function subagentPathKey(path: AgentPath): string {
  return JSON.stringify(path);
}

function copyAgentPath(path: AgentPath): AgentPath {
  return Object.freeze([...path]);
}

function pathStartsWith(prefix: AgentPath, path: AgentPath): boolean {
  return prefix.length <= path.length && prefix.every((part, index) => part === path[index]);
}

function sameAgentPath(left: AgentPath | null | undefined, right: AgentPath | null | undefined): boolean {
  return left !== null && left !== undefined && right !== null && right !== undefined && left.length === right.length && left.every((part, index) => part === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringArrayField(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return undefined;
  return [...value];
}

function pathField(value: unknown): AgentPath | undefined {
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) return copyAgentPath(value);
  if (typeof value === 'string' && value.length > 0) return copyAgentPath(value.split('/').filter(Boolean));
  return undefined;
}

function candidatePath(value: unknown, owner: AgentPath): AgentPath | undefined {
  const raw = isRecord(value) ? (value.path ?? value.id) : value;
  const path = pathField(raw);
  if (!path || path.length === 0) return undefined;
  if (isRecord(value) && Array.isArray(value.path)) return path;
  return pathStartsWith(owner, path) ? path : copyAgentPath([...owner, ...path]);
}

function draftFromCandidate(value: unknown): SubagentResurrectionDraft {
  if (!isRecord(value)) return {};
  const sessionId = stringField(value.sessionId);
  const task = stringField(value.task);
  const channels = stringArrayField(value.channels);
  const model = stringField(value.model);
  return {
    ...(sessionId ? { savedSessionId: sessionId } : {}),
    ...(task ? { task } : {}),
    ...(channels ? { channels } : {}),
    ...(model ? { model } : {}),
  };
}

function mergeResurrectionDraft(first: SubagentResurrectionDraft, second: SubagentResurrectionDraft): SubagentResurrectionDraft {
  return {
    ...(first.savedSessionId !== undefined || second.savedSessionId !== undefined ? { savedSessionId: second.savedSessionId ?? first.savedSessionId } : {}),
    ...(first.task !== undefined || second.task !== undefined ? { task: second.task ?? first.task } : {}),
    ...(first.channels !== undefined || second.channels !== undefined ? { channels: second.channels ?? first.channels } : {}),
    ...(first.model !== undefined || second.model !== undefined ? { model: second.model ?? first.model } : {}),
  };
}

function draftFromSubagentContent(content: Extract<PimoteMessageContent, { type: 'subagent' }>, target: AgentPath): SubagentResurrectionDraft {
  if (!isRecord(content.data)) return {};
  const operation = content.data.operation;
  if (operation !== 'delegation' && operation !== 'resurrect' && operation !== 'teardown') return {};
  const owner = content.subagentPath ?? [];
  const parameters: Record<string, unknown> = isRecord(content.data.parameters) ? content.data.parameters : {};
  const result: Record<string, unknown> = isRecord(content.data.result) ? content.data.result : {};
  const parameterAgents = Array.isArray(parameters.agents) ? parameters.agents : [];
  const resultAgents = operation === 'delegation' ? (Array.isArray(result.children) ? result.children : []) : Array.isArray(result.affectedAgents) ? result.affectedAgents : [];
  let draft: SubagentResurrectionDraft = {};
  for (const candidate of [...parameterAgents, ...resultAgents]) {
    if (!sameAgentPath(candidatePath(candidate, owner), target)) continue;
    draft = mergeResurrectionDraft(draft, draftFromCandidate(candidate));
  }
  return draft;
}

function draftFromMessages(messages: readonly PimoteAgentMessage[], target: AgentPath): SubagentResurrectionDraft {
  let draft: SubagentResurrectionDraft = {};
  for (const message of messages) {
    for (const content of message.content) {
      if (content.type !== 'subagent') continue;
      draft = mergeResurrectionDraft(draft, draftFromSubagentContent(content, target));
    }
  }
  return draft;
}

function isSubagentTopologyEvent(event: WireSubagentTopologyEvent): boolean {
  return event.kind === 'node_added' || event.kind === 'node_updated' || event.kind === 'node_removed' || event.kind === 'runtime_replaced';
}

/** A local close keeps its own reason; the server never sends `released`. */
export type SubagentAttachmentCloseReason = SubagentViewClosedEvent['reason'] | 'released';

/** Session state plus the identity and lifetime of its borrowed child view. */
export interface SubagentAttachmentState extends PerSessionState {
  readonly rootSessionId: string;
  readonly path: AgentPath;
  incarnation: string;
  viewCursor: number;
  closed: boolean;
  closeReason?: SubagentAttachmentCloseReason;
}

export interface SubagentRootState {
  readonly rootSessionId: string;
  rootCwd?: string;
  nodes: SubagentNodeSnapshot[];
  providerCursor: FeedCursor | null;
  manifest: SubagentSnapshot['manifest'];
  activeOperations: SubagentSnapshot['activeOperations'];
  /** Distinguishes an empty authoritative tree from the pre-snapshot race. */
  hierarchySnapshotReceived: boolean;
  projectedSubagentContent: SubagentContentState;
  attachments: Record<string, SubagentAttachmentState>;
}

export interface SubagentViewClosedNotice {
  readonly rootSessionId: string;
  readonly path: AgentPath;
  readonly reason: SubagentAttachmentCloseReason;
  /** Last known node metadata, when the provider supplied it before removal. */
  readonly node?: SubagentNodeSnapshot;
  /** Durable teardown metadata, available after reload or reconnect. */
  readonly resurrection?: SubagentResurrectionDraft;
}

export type ViewedSurface =
  | { readonly kind: 'root'; readonly rootSessionId: string; readonly session: PerSessionState }
  | { readonly kind: 'child'; readonly rootSessionId: string; readonly path: AgentPath; readonly attachment: SubagentAttachmentState };

interface PendingNewSessionRequest {
  folderPath: string;
  previousViewedSessionId: string | null;
  cancelled: boolean;
}

// New-session requests are independent. A singleton pending id cannot reconcile
// parallel opens or preserve the session that each caller is viewing.
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- request reconciliation registry, not reactive UI state
const pendingNewSessionRequests = new Map<string, PendingNewSessionRequest>();
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- cancellation bookkeeping, not reactive UI state
const cancelledNewSessionIds = new Set<string>();
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- in-flight lifecycle attachment registry, not reactive UI state
const lifecycleAttachmentPromises = new Map<string, Promise<boolean>>();
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- attachment deduplication bookkeeping, not reactive UI state
const attachedSessionIds = new Set<string>();

function utf8ByteLength(value: string): number {
  return bashTextEncoder.encode(value).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0 || value.length === 0) return '';
  // Every UTF-16 code unit consumes at least one UTF-8 byte. Avoid encoding a
  // potentially enormous delta just to discover that it exceeds the budget.
  if (value.length <= maxBytes && utf8ByteLength(value) <= maxBytes) return value;

  let low = 0;
  let high = Math.min(value.length, maxBytes);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8ByteLength(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

function hasPositiveUsage(usage: PimoteUsage | undefined): usage is PimoteUsage {
  if (!usage) return false;
  const values = [
    usage.input,
    usage.output,
    usage.cacheRead,
    usage.cacheWrite,
    usage.totalTokens,
    usage.cost.input,
    usage.cost.output,
    usage.cost.cacheRead,
    usage.cost.cacheWrite,
    usage.cost.total,
  ];
  return values.every((value) => Number.isFinite(value) && value >= 0) && values.some((value) => value > 0);
}

function isZeroUsage(usage: PimoteUsage | undefined): boolean {
  if (!usage) return false;
  const values = [
    usage.input,
    usage.output,
    usage.cacheRead,
    usage.cacheWrite,
    usage.totalTokens,
    usage.cost.input,
    usage.cost.output,
    usage.cost.cacheRead,
    usage.cost.cacheWrite,
    usage.cost.total,
  ];
  return values.every((value) => value === 0);
}

/** Append a live delta without allowing the transient browser buffer to grow unbounded. */
/** Append a live delta, trusting the caller's tracked byte count when provided
 *  so a growing buffer is never re-encoded in full per delta. */
function appendBoundedBashOutput(current: string, delta: string, maxBytes: number, trackedBytes?: number): { output: string; bytes: number; truncated: boolean } {
  const currentBytes = trackedBytes ?? utf8ByteLength(current);
  if (currentBytes >= maxBytes) {
    const boundedCurrent = currentBytes > maxBytes ? truncateUtf8(current, maxBytes) : current;
    return { output: boundedCurrent, bytes: utf8ByteLength(boundedCurrent), truncated: delta.length > 0 || boundedCurrent !== current };
  }

  const available = maxBytes - currentBytes;
  // A delta with more code units than the remaining byte budget cannot fit;
  // avoid allocating a full encoded copy for that common high-volume case.
  const deltaBytes = delta.length <= available ? utf8ByteLength(delta) : available + 1;
  if (deltaBytes <= available) {
    return { output: current + delta, bytes: currentBytes + deltaBytes, truncated: false };
  }

  // Find the largest UTF-8-safe prefix of this delta that fits the remaining
  // budget. Binary search avoids repeatedly copying the entire output string.
  let low = 0;
  let high = Math.min(delta.length, available);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8ByteLength(delta.slice(0, middle)) <= available) low = middle;
    else high = middle - 1;
  }
  const prefix = delta.slice(0, low);
  return {
    output: current + prefix,
    bytes: currentBytes + utf8ByteLength(prefix),
    truncated: true,
  };
}

/** Reduce a wire `tool_execution_end` result — the full SDK AgentToolResult
 *  (`{content, details, structuredContent}`) — to the display text plus the
 *  structured payload. Anything else (plain strings) passes through as text
 *  with no data. */
function reduceEndEventResult(result: unknown): { text: unknown; data: unknown } {
  if (result !== null && typeof result === 'object' && Array.isArray((result as { content?: unknown }).content)) {
    const wrapper = result as { content: Array<{ type: string; text?: string }>; details?: unknown; structuredContent?: unknown };
    const texts = wrapper.content.flatMap((block) => (block.type === 'text' && block.text !== undefined ? [block.text] : []));
    return { text: texts.length > 0 ? texts.join('\n') : undefined, data: wrapper.structuredContent ?? wrapper.details };
  }
  return { text: result, data: undefined };
}

type ToolExecutionRecord = {
  name: string;
  args: unknown;
  partialResult: string;
  status: 'running' | 'completed';
  result?: unknown;
  data?: unknown;
  images?: PimoteImageContent[];
  isError?: boolean;
  durationMs?: number;
};

function findToolCallInMessages(messages: readonly PimoteAgentMessage[], toolCallId: string): PimoteMessageContent | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const block = messages[index].content.find((candidate) => candidate.type === 'tool_call' && candidate.toolCallId === toolCallId);
    if (block) return block;
  }
  return undefined;
}

/** Rebuild historical native tool state before applying the live running IDs. */
function rebuildToolExecutionsFromMessages(messages: readonly PimoteAgentMessage[], runningToolCallIds: readonly string[] = []): Record<string, ToolExecutionRecord> {
  const executions: Record<string, ToolExecutionRecord> = {};
  for (const message of messages) {
    if (message.role !== 'toolResult') continue;
    for (const block of message.content) {
      if (block.type !== 'tool_result' || !block.toolCallId) continue;
      executions[block.toolCallId] = {
        name: block.toolName ?? 'unknown',
        args: undefined,
        partialResult: '',
        status: 'completed',
        result: block.result,
        data: block.data,
        images: block.images,
        isError: block.isError,
        ...(block.durationMs !== undefined ? { durationMs: block.durationMs } : {}),
      };
    }
  }
  for (const toolCallId of runningToolCallIds) {
    const call = findToolCallInMessages(messages, toolCallId);
    executions[toolCallId] = {
      name: call?.toolName ?? '',
      args: call?.args,
      partialResult: '',
      status: 'running',
    };
  }
  return executions;
}

/** Zip saved tail IDs into finalized messages, skipping entries Pi never persists. */
function hydrateMessageEntryIds(session: Pick<PerSessionState, 'messages' | 'messageKeys' | 'optimisticEntries'>, ids: readonly string[]): void {
  const pendingKeys = session.optimisticEntries.map((entry) => entry.key);
  let idIndex = ids.length - 1;
  for (let index = session.messages.length - 1; index >= 0 && idIndex >= 0; index--) {
    if (pendingKeys.includes(session.messageKeys[index])) continue;
    const message = session.messages[index];
    const isAbortedPlaceholder = message.role === 'assistant' && message.aborted === true && message.content.every((content) => content.type === 'text' && !content.text);
    if (isAbortedPlaceholder) continue;
    if (message.entryId !== undefined && message.entryId !== ids[idIndex]) break;
    message.entryId = ids[idIndex--];
  }
}

type ProjectedTranscript = Pick<PerSessionState, 'messages' | 'messageKeys' | 'optimisticEntries' | 'projectedSubagentContent'>;

function applyProjectedEventToTranscript(transcript: ProjectedTranscript, event: SubagentContentEvent, generateKeys: (count: number) => string[]): void {
  if (event.type === 'subagent_content_delta') {
    const projected = applySubagentContentDeltaInPlace(transcript.projectedSubagentContent, event, transcript.messages);
    if (projected) {
      transcript.projectedSubagentContent = projected;
      return;
    }
  }

  // Split confirmed from pending rows in one pass. The projection copies only
  // the message carrying the operation, so this stays a shallow re-fold.
  const pendingKeys = new Set(transcript.optimisticEntries.map((entry) => entry.key));
  const messages = transcript.messages;
  const keys = transcript.messageKeys;
  const confirmedMessages: PimoteAgentMessage[] = [];
  const confirmedKeys: string[] = [];
  const pendingMessages: PimoteAgentMessage[] = [];
  const pendingRowKeys: string[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const key = keys[index];
    if (key !== undefined && pendingKeys.has(key)) {
      pendingMessages.push(messages[index]);
      pendingRowKeys.push(key);
    } else {
      confirmedMessages.push(messages[index]);
      confirmedKeys.push(key);
    }
  }
  const projected = applySubagentContentEvent({ ...transcript.projectedSubagentContent, messages: confirmedMessages }, event);
  const addedKeys = generateKeys(projected.messages.length - confirmedMessages.length);
  transcript.projectedSubagentContent = projected;
  transcript.messages = [...projected.messages, ...pendingMessages];
  transcript.messageKeys = [...confirmedKeys, ...addedKeys, ...pendingRowKeys];
}

function streamingParentTargetsFutureRow(parentMessageId: string, transcript: ProjectedTranscript): boolean {
  const match = /^message-(\d+)$/.exec(parentMessageId);
  if (!match) return false;
  const pendingCount = transcript.optimisticEntries.filter((entry) => transcript.messageKeys.includes(entry.key)).length;
  return Number(match[1]) >= transcript.messages.length - pendingCount;
}

function applyProjectedEventToStreaming(transcript: ProjectedTranscript & Pick<PerSessionState, 'streamingMessage'>, event: SubagentContentEvent): boolean {
  const streaming = transcript.streamingMessage;
  if (!streaming || streaming.role !== 'assistant') return false;
  const operationIsStreaming = streaming.content.some((content) => content.type === 'subagent' && content.operationId === event.operationId);
  if (!operationIsStreaming && !streamingParentTargetsFutureRow(event.parentMessageId, transcript)) return false;
  transcript.streamingMessage = applySubagentContentToStreaming(streaming, event);
  return true;
}

export interface BashExecutionState {
  id: string;
  command: string;
  excludeFromContext: boolean;
  output: string;
  status: 'running' | 'complete' | 'cancelled' | 'error';
  result?: BashResult;
  /** True when live output was capped before the native result arrived. */
  outputTruncated?: boolean;
  /** Dispatch failure distinct from a native nonzero exit or cancellation. */
  error?: string;
}

export interface PerSessionState {
  sessionId: string;
  /** Path of the session's JSONL file on the server; undefined until pi persists it. */
  sessionFile: string | undefined;
  /** Whether this session belongs in the reconnect restore set. */
  restorable: boolean;
  folderPath: string;
  projectName: string;
  /** The folder object this session belongs to — canonicalized through the
   *  folder model when one is bound, so folder metadata updates flow through
   *  the shared object. Bound from the server's FolderInfo (session_opened,
   *  session_replaced): `folderPath` is the folder's path, never the
   *  session's cwd, and the two can differ — the event is the authoritative
   *  link, and the folder need not appear in any list window. Null until
   *  reported. */
  folder: FolderInfo | null;
  firstMessage: string | undefined;
  messages: PimoteAgentMessage[];
  /** Projected subagent blocks in the mixed assistant transcript. */
  projectedSubagentContent: SubagentContentState;
  /** Raw native branch at the last root snapshot boundary. */
  branchEntryIds?: readonly string[];
  isStreaming: boolean;
  /** Invalidates in-flight streaming snapshots when a newer lifecycle event arrives. */
  streamingRevision: number;
  isCompacting: boolean;
  /** True while a tree navigation (optional branch summary) is in progress. */
  isNavigatingTree?: boolean;
  /** Whether the in-progress tree navigation will produce a branch summary. */
  treeNavigationSummarizing?: boolean;
  model: { provider: string; id: string; name: string } | null;
  thinkingLevel: string;
  /** Server-provided list of thinking levels the current model supports. */
  availableThinkingLevels: string[];
  streamingMessage: StreamingMessage | null;
  streamingKey: string | null;
  /** Last positive assistant snapshot retained until a terminal event. */
  lastPositiveStreamingUsage: PimoteUsage | null;
  /** Partial usage waiting for its terminal assistant message to arrive. */
  pendingAssistantUsage: { key: string; usage: PimoteUsage } | null;
  /** Client-only terminal partials keyed by the stable transcript message key. */
  assistantUsageOverrides: Record<string, PimoteUsage>;
  messageKeys: string[];
  toolExecutions: Record<string, ToolExecutionRecord>;
  /** Transient native bash executions keyed by caller-owned command ID. */
  bashExecutions: Record<string, BashExecutionState>;
  autoCompactionEnabled: boolean;
  messageCount: number;
  status: 'idle' | 'working';
  needsAttention: boolean;
  conflictingProcesses: Array<{ pid: number; command: string }>;
  gitBranch: string | null;
  sessionName: string | null;
  extensionTitle: string | null;
  restoreMode: RestoreMode | null;
  isRestoring: boolean;
  panelCards: Card[];
  /** Pending user-approved file downloads offered for this session. */
  downloads: DownloadItem[];
  widgetCards: Record<string, Card>;
  contextUsage: { percent: number | null; contextWindow: number } | null;
  /** Total USD cost from Pi's complete session statistics; 0 when no spend. */
  lifetimeCostUsd: number;
  /** Category rollup from persisted usage entries, when supplied by the server. */
  usageBreakdown?: PimoteUsageBreakdown;
  draftText: string;
  pendingSteeringMessages: string[];
  lastBotActivityTimestamp: string | null;
  /** Optimistic user entries awaiting their prompt's outcome, oldest first.
   * The user echo stamped with an entry's clientMessageId replaces it in
   * place. Every other confirmed message inserts ahead of the oldest entry. */
  optimisticEntries: OptimisticEntry[];
}

/** An optimistic user entry: its render key and the id its echo carries. */
export interface OptimisticEntry {
  key: string;
  clientMessageId: string;
}

export class SessionRegistry {
  /** Receives typed updates after their owning session snapshot has been reduced. */
  constructor(private readonly onDownloadUpdate?: (event: DownloadUpdateEvent) => void) {}

  /** Client-only URL sync target (see lib/nav.ts). Null in tests/SSR — state changes stay local. */
  private viewNavigator: { toViewed(sessionId: string | null, opts: { replace: boolean }): void } | null = null;

  /**
   * In-flight registry→URL navigation: the view the registry chose and is
   * navigating the browser toward. `goto()` commits a tick after the view
   * change, so the URL is stale in between — the route effect defers while
   * this is pending instead of "correcting" back to the stale URL (which would
   * undo the user's click mid-flight). Object wrapper so "navigating home"
   * (target null) is distinguishable from "no navigation". Cleared by the
   * route once the URL catches up or takes the lead.
   */
  private viewNavigation: { target: string | null } | null = null;

  /** Called once from lib/nav.ts at app boot to mirror viewed-session changes into the URL. */
  setViewNavigator(nav: { toViewed(sessionId: string | null, opts: { replace: boolean }): void }): void {
    this.viewNavigator = nav;
  }

  /** Folder-model canonicalizer for bindSessionFolder — collapses wire
   *  FolderInfo rows onto the client's shared folder objects. Late-bound
   *  from the folder store (which already imports the registry) to avoid a
   *  module cycle. */
  private folderObjectResolver: ((row: FolderInfo) => FolderInfo) | null = null;

  /** Called once from the folder store at module boot. */
  setFolderObjectResolver(resolve: (row: FolderInfo) => FolderInfo): void {
    this.folderObjectResolver = resolve;
  }

  /** True while the registry has navigated the browser toward its chosen view and the URL has not caught up. */
  isViewNavigationPending(): boolean {
    return this.viewNavigation?.target === this.viewedSessionId;
  }

  /** The URL caught up to the registry's view, or took the lead — drop the in-flight marker. */
  clearViewNavigation(): void {
    this.viewNavigation = null;
  }

  private navigateToViewed(replace: boolean): void {
    if (!this.viewNavigator) return;
    this.viewNavigation = { target: this.viewedSessionId };
    this.viewNavigator.toViewed(this.viewedSessionId, { replace });
  }

  sessions: Record<string, PerSessionState> = $state({});
  viewedSessionId: string | null = $state(null);
  /** The server's chip order. `activeSessions` projects through it, so a new
   *  session appends without a re-sort (D6). */
  sessionOrder: string[] = $state([]);
  /** Epoch of `sessionOrder`, sent back as `baseVersion` on the next
   *  whole-order write. */
  orderVersion: number = $state(0);
  /** The user's selected session — one fact shared across their connections,
   *  so every one of them highlights it and navigates to it (D1). */
  selectedSessionId: string | null = $state(null);
  /** Root-scoped hierarchy and child surfaces. Deliberately separate from
   * `sessions`: child paths never become root session tabs or URL targets. */
  subagentRoots: Record<string, SubagentRootState> = $state({});
  private selectedSubagentPaths: Record<string, AgentPath | null> = $state({});
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- listeners are an imperative edge, not UI state
  private subagentViewListeners = new Set<(notice: SubagentViewClosedNotice) => void>();
  // Resurrection actions can originate in the transcript while the panel is
  // closed. Keep the closed node metadata until the confirmation flow consumes
  // it, and expose a small bridge for the panel to open that flow.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- listener registry, not UI state
  private subagentResurrectionListeners = new Set<(notice: SubagentViewClosedNotice) => void>();
  private subagentClosedNotices: Record<string, SubagentViewClosedNotice> = $state({});
  private subagentResurrectionRequests: Record<string, SubagentViewClosedNotice> = $state({});
  subagentNoticeVersion = $state(0);
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- in-flight child opens are request bookkeeping
  private pendingSubagentOpens = new Map<string, Promise<SubagentAttachmentState | null>>();
  /** The user's open child views, as the server profile states them. */
  private userViews: UserOpenViewRef[] = [];
  private _nextMessageKey: number = 0;
  // Byte accounting lives outside the reactive execution object so the public
  // state shape stays focused on rendering and existing callers remain stable.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- internal accounting, not UI state
  private bashOutputBytes = new Map<string, number>();

  private bashOutputKey(sessionId: string, executionId: string): string {
    return `${sessionId}\u0000${executionId}`;
  }

  private subagentNoticeKey(rootSessionId: string, path: AgentPath): string {
    return `${rootSessionId}\u0000${subagentPathKey(path)}`;
  }

  private clearBashOutputBytes(sessionId: string): void {
    const prefix = `${sessionId}\u0000`;
    for (const key of this.bashOutputBytes.keys()) {
      if (key.startsWith(prefix)) this.bashOutputBytes.delete(key);
    }
  }

  /** Generate stable keys for a batch of messages (used on initial load and resync) */
  generateMessageKeys(count: number): string[] {
    return Array.from({ length: count }, () => 'msg-' + this._nextMessageKey++);
  }

  /** Get the currently viewed session's state */
  get viewed(): PerSessionState | null {
    return this.sessions[this.viewedSessionId!] ?? null;
  }

  get viewedConversation(): PerSessionState | null {
    return this.viewedSubagentAttachment ?? this.viewed;
  }

  getSessionState(sessionId: string): PerSessionState | null {
    if (this.sessions[sessionId]) return this.sessions[sessionId];
    for (const root of Object.values(this.subagentRoots)) {
      for (const attachment of Object.values(root.attachments)) {
        if (!attachment.closed && attachment.sessionId === sessionId) return attachment;
      }
    }
    return null;
  }

  /** List sessions that belong to the server restore set, in chip order. */
  get activeSessions(): PerSessionState[] {
    return projectChipOrder(
      Object.values(this.sessions).filter((session) => session.restorable),
      this.sessionOrder,
    );
  }

  /**
   * Apply the order and selection one `user_sessions_changed` carries. A
   * refused whole-order write is answered with current facts, which land here
   * and put the server's order back in charge.
   */
  applyUserSessionFacts(facts: UserSessionFacts): void {
    this.sessionOrder = [...facts.order];
    this.orderVersion = facts.orderVersion;
    this.selectedSessionId = facts.selectedSessionId;
    const selected = facts.selectedSessionId ? this.sessions[facts.selectedSessionId] : undefined;
    if (selected) selected.needsAttention = false;
    this.followSelection();
  }

  /**
   * Move the view to the user's selection when another connection set it.
   * Nothing goes back over the wire: the server already holds this selection,
   * and answering with `view_session` is the loop the follow must not close.
   */
  private followSelection(): void {
    const target = this.selectedSessionId;
    if (!target) return;
    const decision = followDecision({
      selectedSessionId: target,
      viewedSessionId: this.viewedSessionId,
      knownSessionIds: Object.values(this.sessions)
        .filter((session) => session.restorable)
        .map((session) => session.sessionId),
    });
    if (decision === 'navigate') this.switchTo(target);
  }

  /** Record this connection's chosen session as the user's selection. The
   *  server clears its attention for every connection of the user (D3) and
   *  turns the others' views to it (D1). */
  selectSession(sessionId: string): void {
    this.selectedSessionId = sessionId;
    const session = this.sessions[sessionId];
    if (session) session.needsAttention = false;
    const folderPath = session?.folderPath;
    connection.send({ type: 'view_session', sessionId, ...(folderPath ? { folderPath } : {}) }).catch(() => {});
  }

  /** Move a chip in the local projection only. Returns false when the order
   *  would not change. */
  moveSession(fromIndex: number, toIndex: number): boolean {
    const ids = this.activeSessions.map((session) => session.sessionId);
    const next = moveChipOrder(ids, fromIndex, toIndex);
    if (next.every((id, index) => id === ids[index])) return false;
    this.sessionOrder = next;
    return true;
  }

  /** Push the local order as a whole-order write. The acting connection keeps
   *  its own order — the server echoes only to the user's other connections —
   *  and the response carries the next epoch. */
  pushSessionOrder(): void {
    const order = this.activeSessions.map((session) => session.sessionId);
    connection
      .send({ type: 'reorder_sessions', order, baseVersion: this.orderVersion })
      .then((response) => {
        const data = response.data as ReorderSessionsResponseData | undefined;
        // A refused write is answered with current facts instead: those arrive
        // as an event and put the server's order back in charge.
        if (data?.accepted) this.orderVersion = data.orderVersion;
      })
      .catch(() => {});
  }

  private createSubagentRoot(rootSessionId: string): SubagentRootState {
    return {
      rootSessionId,
      nodes: [],
      providerCursor: null,
      manifest: { hiddenToolNames: [], hiddenCustomTypes: [] },
      activeOperations: [],
      hierarchySnapshotReceived: false,
      projectedSubagentContent: hydrateSubagentContent([]),
      attachments: {},
    };
  }

  private ensureSubagentRoot(rootSessionId: string): SubagentRootState {
    const existing = this.subagentRoots[rootSessionId];
    if (existing) return existing;
    const created = this.createSubagentRoot(rootSessionId);
    this.subagentRoots[rootSessionId] = created;
    return created;
  }

  getSubagentRoot(rootSessionId: string): SubagentRootState | null {
    return this.subagentRoots[rootSessionId] ?? null;
  }

  getSubagentSnapshot(rootSessionId: string): SubagentSnapshot | null {
    const root = this.subagentRoots[rootSessionId];
    if (!root || !root.providerCursor) return null;
    return {
      nodes: root.nodes,
      cursor: root.providerCursor,
      manifest: root.manifest,
      activeOperations: root.activeOperations,
      ...(root.rootCwd !== undefined ? { rootCwd: root.rootCwd } : {}),
    };
  }

  clearSubagentRoot(rootSessionId: string): void {
    const root = this.subagentRoots[rootSessionId];
    if (root) {
      for (const attachment of Object.values(root.attachments)) {
        if (!attachment.closed) this.closeSubagentAttachment(root, attachment, 'released');
      }
    }
    const { [rootSessionId]: _removed, ...remaining } = this.subagentRoots;
    this.subagentRoots = remaining;
    const { [rootSessionId]: _selected, ...remainingSelected } = this.selectedSubagentPaths;
    this.selectedSubagentPaths = remainingSelected;
    const prefix = `${rootSessionId}\u0000`;
    this.subagentClosedNotices = Object.fromEntries(Object.entries(this.subagentClosedNotices).filter(([key]) => !key.startsWith(prefix)));
    this.subagentResurrectionRequests = Object.fromEntries(Object.entries(this.subagentResurrectionRequests).filter(([key]) => !key.startsWith(prefix)));
    this.subagentNoticeVersion += 1;
  }

  getSubagentAttachment(rootSessionId: string, path: AgentPath): SubagentAttachmentState | null {
    return this.subagentRoots[rootSessionId]?.attachments[subagentPathKey(path)] ?? null;
  }

  getSubagentAttachments(rootSessionId: string): readonly SubagentAttachmentState[] {
    return Object.values(this.subagentRoots[rootSessionId]?.attachments ?? {});
  }

  getSelectedSubagentPath(rootSessionId: string): AgentPath | null {
    const path = this.selectedSubagentPaths[rootSessionId];
    return path ? copyAgentPath(path) : null;
  }

  /** The currently selected child surface for one root, if it is still live. */
  getSelectedSubagentAttachment(rootSessionId: string): SubagentAttachmentState | null {
    const path = this.getSelectedSubagentPath(rootSessionId);
    if (!path) return null;
    const attachment = this.getSubagentAttachment(rootSessionId, path);
    return attachment && !attachment.closed ? attachment : null;
  }

  /** Root or selected child surface for the current conversation. */
  get viewedSurface(): ViewedSurface | null {
    const rootSessionId = this.viewedSessionId;
    const session = rootSessionId ? this.sessions[rootSessionId] : undefined;
    if (!rootSessionId || !session) return null;
    const attachment = this.getSelectedSubagentAttachment(rootSessionId);
    if (!attachment) return { kind: 'root', rootSessionId, session };
    return { kind: 'child', rootSessionId, path: copyAgentPath(attachment.path), attachment };
  }

  get viewedSubagentAttachment(): SubagentAttachmentState | null {
    const surface = this.viewedSurface;
    return surface?.kind === 'child' ? surface.attachment : null;
  }

  /** Return the hierarchy node for an attached child, including metadata that
   *  is not present on the borrowed native session snapshot. */
  getSubagentNode(rootSessionId: string, path: AgentPath): SubagentNodeSnapshot | null {
    return this.subagentRoots[rootSessionId]?.nodes.find((node) => sameAgentPath(node.path, path)) ?? null;
  }

  selectSubagentView(rootSessionId: string, path: AgentPath | null): void {
    this.selectedSubagentPaths[rootSessionId] = path ? copyAgentPath(path) : null;
  }

  onSubagentViewClosed(listener: (notice: SubagentViewClosedNotice) => void): () => void {
    this.subagentViewListeners.add(listener);
    return () => this.subagentViewListeners.delete(listener);
  }

  onSubagentResurrectionRequested(listener: (notice: SubagentViewClosedNotice) => void): () => void {
    this.subagentResurrectionListeners.add(listener);
    return () => this.subagentResurrectionListeners.delete(listener);
  }

  getPendingSubagentResurrection(rootSessionId: string): SubagentViewClosedNotice | null {
    const pending = Object.entries(this.subagentResurrectionRequests).find(([key]) => key.startsWith(`${rootSessionId}\u0000`));
    return pending?.[1] ?? null;
  }

  getSubagentViewClosedNotice(rootSessionId: string, path: AgentPath): SubagentViewClosedNotice | null {
    return this.subagentClosedNotices[this.subagentNoticeKey(rootSessionId, path)] ?? null;
  }

  getLatestSubagentClosedNotice(rootSessionId: string): SubagentViewClosedNotice | null {
    const prefix = `${rootSessionId}\u0000`;
    const notices = Object.entries(this.subagentClosedNotices).filter(([key]) => key.startsWith(prefix));
    return notices.at(-1)?.[1] ?? null;
  }

  requestSubagentResurrection(rootSessionId: string, path: AgentPath, supplied: SubagentResurrectionDraft = {}): void {
    const key = this.subagentNoticeKey(rootSessionId, path);
    const stored = this.subagentClosedNotices[key];
    const node = this.getSubagentNode(rootSessionId, path);
    const attachment = this.getSubagentAttachment(rootSessionId, path);
    const root = this.subagentRoots[rootSessionId];
    const transcriptDraft = draftFromMessages(
      [...(this.sessions[rootSessionId] ? [this.sessions[rootSessionId]] : []), ...Object.values(root?.attachments ?? {})].flatMap((session) => session.messages),
      path,
    );
    const nodeDraft: SubagentResurrectionDraft = node
      ? {
          savedSessionId: node.sessionId,
          ...(node.task !== undefined ? { task: node.task } : {}),
          channels: [...node.channels],
          ...(node.model !== undefined ? { model: node.model } : {}),
        }
      : {};
    const attachmentDraft = attachment?.sessionId ? { savedSessionId: attachment.sessionId } : {};
    const resurrection = mergeResurrectionDraft(mergeResurrectionDraft(transcriptDraft, attachmentDraft), mergeResurrectionDraft(nodeDraft, supplied));
    const base: SubagentViewClosedNotice = stored ?? {
      rootSessionId,
      path: copyAgentPath(path),
      reason: 'teardown',
      ...(node ? { node } : {}),
    };
    const notice: SubagentViewClosedNotice = Object.keys(resurrection).length > 0 ? { ...base, resurrection } : base;
    this.subagentResurrectionRequests = { ...this.subagentResurrectionRequests, [key]: notice };
    this.subagentNoticeVersion += 1;
    panelStore.revealPanel();
    for (const listener of [...this.subagentResurrectionListeners]) {
      try {
        listener(notice);
      } catch (error) {
        console.error('[SessionRegistry] Subagent resurrection listener error:', error);
      }
    }
  }

  clearPendingSubagentResurrection(rootSessionId: string, path: AgentPath): void {
    const key = this.subagentNoticeKey(rootSessionId, path);
    if (this.subagentResurrectionRequests[key]) {
      const { [key]: _removed, ...remaining } = this.subagentResurrectionRequests;
      this.subagentResurrectionRequests = remaining;
    }
    if (this.subagentClosedNotices[key]) {
      const { [key]: _removed, ...remaining } = this.subagentClosedNotices;
      this.subagentClosedNotices = remaining;
    }
    this.subagentNoticeVersion += 1;
  }

  private notifySubagentClosed(rootSessionId: string, path: AgentPath, reason: SubagentAttachmentCloseReason, node?: SubagentNodeSnapshot): void {
    const selected = this.selectedSubagentPaths[rootSessionId];
    if (selected && (sameAgentPath(selected, path) || pathStartsWith(path, selected))) {
      this.selectedSubagentPaths[rootSessionId] = null;
    }
    const notice: SubagentViewClosedNotice = { rootSessionId, path: copyAgentPath(path), reason, ...(node ? { node } : {}) };
    if (reason === 'teardown') {
      const key = this.subagentNoticeKey(rootSessionId, path);
      this.subagentClosedNotices = { ...this.subagentClosedNotices, [key]: notice };
    }
    for (const listener of [...this.subagentViewListeners]) {
      try {
        listener(notice);
      } catch (error) {
        console.error('[SessionRegistry] Subagent view listener error:', error);
      }
    }
  }

  private closeSubagentAttachment(root: SubagentRootState, attachment: SubagentAttachmentState, reason: SubagentAttachmentCloseReason, node?: SubagentNodeSnapshot): void {
    if (attachment.closed) {
      // A topology removal is more specific than an unavailable snapshot that
      // raced it. Update the stored reason without emitting a duplicate notice.
      if (reason === 'teardown') attachment.closeReason = reason;
      return;
    }
    attachment.closed = true;
    attachment.closeReason = reason;
    this.notifySubagentClosed(root.rootSessionId, attachment.path, reason, node);
  }

  private createSubagentAttachment(rootSessionId: string, snapshot: SubagentViewSnapshot): SubagentAttachmentState {
    const node = this.getSubagentNode(rootSessionId, snapshot.path);
    const parent = this.sessions[rootSessionId];
    return {
      ...this.createSessionState(snapshot.childSessionId, node?.cwd ?? parent?.folderPath ?? '', snapshot.path.at(-1) ?? 'subagent'),
      rootSessionId,
      path: copyAgentPath(snapshot.path),
      incarnation: snapshot.incarnation,
      viewCursor: snapshot.viewCursor,
      closed: false,
    };
  }

  private createSessionState(sessionId: string, folderPath: string, projectName: string): PerSessionState {
    return {
      sessionId,
      sessionFile: undefined,
      restorable: true,
      folderPath,
      projectName,
      folder: null,
      firstMessage: undefined,
      messages: [],
      projectedSubagentContent: hydrateSubagentContent([]),
      isStreaming: false,
      streamingRevision: 0,
      isCompacting: false,
      isNavigatingTree: false,
      treeNavigationSummarizing: false,
      model: null,
      thinkingLevel: 'off',
      availableThinkingLevels: [],
      streamingMessage: null,
      streamingKey: null,
      lastPositiveStreamingUsage: null,
      pendingAssistantUsage: null,
      assistantUsageOverrides: {},
      messageKeys: [],
      toolExecutions: {},
      bashExecutions: {},
      autoCompactionEnabled: false,
      messageCount: 0,
      status: 'idle',
      needsAttention: false,
      conflictingProcesses: [],
      sessionName: null,
      extensionTitle: null,
      restoreMode: null,
      isRestoring: false,
      panelCards: [],
      downloads: [],
      widgetCards: {},
      gitBranch: null,
      contextUsage: null,
      lifetimeCostUsd: 0,
      draftText: '',
      pendingSteeringMessages: [],
      lastBotActivityTimestamp: null,
      optimisticEntries: [],
    };
  }

  firstUserMessage(messages: PimoteAgentMessage[]): string | undefined {
    for (const message of messages) {
      if (message.role !== 'user') continue;
      const textContent = message.content.find((c: PimoteMessageContent) => c.type === 'text');
      if (textContent?.text) return textContent.text;
    }
    return undefined;
  }

  /** Add an optimistic user message so it renders immediately before the server round-trip.
   *  `clientMessageId` must match the prompt command's id. */
  addOptimisticUserMessage(sessionId: string, text: string, clientMessageId: string, images: readonly string[] = []): void {
    const session = this.getSessionState(sessionId);
    if (!session) return;

    const content: PimoteMessageContent[] = [];
    if (text) {
      content.push({ type: 'text', text });
    }
    content.push(...imageContentBlocksFromDataUrls(images));

    const message: PimoteAgentMessage = { role: 'user', content };
    const key = 'msg-' + this._nextMessageKey++;
    session.messages = [...session.messages, message];
    session.messageKeys = [...session.messageKeys, key];
    session.optimisticEntries = [...session.optimisticEntries, { key, clientMessageId }];
  }

  /** Remove an optimistic user message whose prompt will not echo it
   *  (queued, handled, rejected, or lost with the connection). */
  dropOptimisticUserMessage(sessionId: string, clientMessageId: string): void {
    const session = this.getSessionState(sessionId);
    if (!session) return;
    const entry = session.optimisticEntries.find((e) => e.clientMessageId === clientMessageId);
    if (!entry) return;
    session.optimisticEntries = session.optimisticEntries.filter((e) => e !== entry);
    const idx = session.messageKeys.indexOf(entry.key);
    if (idx === -1) return;
    session.messages = session.messages.filter((_, i) => i !== idx);
    session.messageKeys = session.messageKeys.filter((_, i) => i !== idx);
  }

  private resetAssistantUsageTracking(session: PerSessionState, clearOverrides = false): void {
    session.lastPositiveStreamingUsage = null;
    session.pendingAssistantUsage = null;
    if (clearOverrides) session.assistantUsageOverrides = {};
  }

  clearAssistantUsageTracking(sessionId: string): void {
    const session = this.getSessionState(sessionId);
    if (session) this.resetAssistantUsageTracking(session, true);
  }

  private rememberStreamingUsage(session: PerSessionState, usage: PimoteUsage | undefined): void {
    if (usage === undefined) return;
    if (!session.streamingMessage) return;
    session.streamingMessage = { ...session.streamingMessage, usage };
    if (session.streamingMessage.role === 'assistant' && hasPositiveUsage(usage)) {
      session.lastPositiveStreamingUsage = usage;
    }
  }

  private retainPartialAssistantUsage(session: PerSessionState): void {
    if (!session.streamingKey || !session.lastPositiveStreamingUsage) return;
    if (session.streamingMessage?.role !== 'assistant') return;
    session.pendingAssistantUsage = {
      key: session.streamingKey,
      usage: session.lastPositiveStreamingUsage,
    };
  }

  private storeAssistantUsageOverride(session: PerSessionState, key: string, usage: PimoteUsage): void {
    session.assistantUsageOverrides = {
      ...session.assistantUsageOverrides,
      [key]: usage,
    };
  }

  /** Save draft text for a session and notify a mounted composer, if any. */
  setDraftText(sessionId: string, text: string): void {
    const session = this.getSessionState(sessionId);
    if (session) session.draftText = text;
    setEditorText(sessionId, text);
  }

  private applySubagentHierarchySnapshot(event: SubagentSnapshotEvent): void {
    const rootSessionId = event.sessionId;
    const snapshot = 'snapshot' in event ? event.snapshot : event;
    if (!snapshot.manifest || !Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.activeOperations)) return;
    const root = this.ensureSubagentRoot(rootSessionId);
    const previousCursor = root.providerCursor;
    const epochChanged = previousCursor !== null && previousCursor.epoch !== snapshot.cursor.epoch;
    const staleSameEpoch = previousCursor !== null && previousCursor.epoch === snapshot.cursor.epoch && snapshot.cursor.sequence < previousCursor.sequence;
    const shouldApplyNodes = !root.hierarchySnapshotReceived || !staleSameEpoch || epochChanged;
    if (shouldApplyNodes) {
      const manifest = snapshot.manifest;
      root.manifest = { hiddenToolNames: [...manifest.hiddenToolNames], hiddenCustomTypes: [...manifest.hiddenCustomTypes] };
      root.rootCwd = snapshot.rootCwd;
      root.activeOperations = [...snapshot.activeOperations];
      root.hierarchySnapshotReceived = true;
      root.nodes = [...snapshot.nodes].map((node) => ({
        ...node,
        path: copyAgentPath(node.path),
        channels: [...(node.channels ?? [])],
        waitingFor: (node.waitingFor ?? []).map(copyAgentPath),
      }));
      if (!staleSameEpoch || epochChanged || previousCursor === null) {
        root.providerCursor = { epoch: snapshot.cursor.epoch, sequence: snapshot.cursor.sequence };
      }
    }
    // A lower snapshot can race a replay. Do not let it roll an attachment
    // back to an older runtime. Reconciliation below only closes paths that
    // are absent from the authoritative, non-stale node set.
    if (shouldApplyNodes) {
      for (const attachment of Object.values(root.attachments)) {
        if (attachment.closed) continue;
        const node = root.nodes.find((candidate) => sameAgentPath(candidate.path, attachment.path));
        if (!node) this.closeSubagentAttachment(root, attachment, 'unavailable');
        else if (node.incarnation !== attachment.incarnation) this.closeSubagentAttachment(root, attachment, 'replaced');
      }
    }
    const rootMessages = this.sessions[rootSessionId]?.messages ?? root.projectedSubagentContent.messages;
    const active = snapshot.activeOperations.map((operation) => {
      let parentMessageId = `message-${Math.max(
        0,
        rootMessages.findIndex((message) => message.role === 'assistant'),
      )}`;
      let contentIndex = operation.target.placement && 'toolCallId' in operation.target.placement ? operation.target.placement.contentIndex : 0;
      for (let messageIndex = 0; messageIndex < rootMessages.length; messageIndex += 1) {
        const projectedIndex = rootMessages[messageIndex].content.findIndex((content) => content.type === 'subagent' && content.operationId === operation.target.operationId);
        if (projectedIndex < 0) continue;
        parentMessageId = rootMessages[messageIndex].entryId ?? `message-${messageIndex}`;
        contentIndex = projectedIndex;
        break;
      }
      if (
        operation.target.placement &&
        'entryId' in operation.target.placement &&
        !('toolCallId' in operation.target.placement) &&
        !rootMessages.some((message) => message.content.some((content) => content.type === 'subagent' && content.operationId === operation.target.operationId))
      ) {
        parentMessageId = operation.target.placement.entryId;
      }
      return {
        parentMessageId,
        contentIndex,
        operationId: operation.target.operationId,
        kind: operation.target.kind,
        ...(operation.target.placement ? { placement: operation.target.placement } : {}),
        data: operation.data,
      };
    });
    root.projectedSubagentContent = hydrateSubagentContent(rootMessages, active);
  }

  private applySubagentTopologyEvent(event: WireSubagentTopologyEvent): void {
    const root = this.ensureSubagentRoot(event.sessionId);
    const providerCursor = event.providerCursor;
    const current = root.providerCursor;
    const staleTopology =
      root.hierarchySnapshotReceived &&
      isSubagentTopologyEvent(event) &&
      providerCursor !== undefined &&
      current !== null &&
      providerCursor.epoch === current.epoch &&
      providerCursor.sequence <= current.sequence;
    // A hierarchy snapshot is authoritative through its provider cursor. A
    // late topology event at or before that boundary is already represented by
    // the snapshot and must not roll the tree back or re-enter replay state.
    if (staleTopology) return;
    if (providerCursor && (current === null || current.epoch !== providerCursor.epoch || providerCursor.sequence > current.sequence)) {
      root.providerCursor = { epoch: providerCursor.epoch, sequence: providerCursor.sequence };
    }
    this.applySubagentNodeEvent(root, event);
  }

  private applySubagentNodeEvent(root: SubagentRootState, event: WireSubagentTopologyEvent): void {
    if (event.kind === 'node_added' || event.kind === 'node_updated') {
      const data = event.data;
      const node = 'path' in data ? data : undefined;
      const path = node?.path ?? event.path;
      const index = root.nodes.findIndex((candidate) => sameAgentPath(candidate.path, path));
      if (node) {
        const copy = {
          ...node,
          path: copyAgentPath(node.path),
          channels: [...(node.channels ?? [])],
          waitingFor: (node.waitingFor ?? []).map(copyAgentPath),
        };
        if (index >= 0) root.nodes[index] = copy;
        else root.nodes = [...root.nodes, copy];
      } else if (index >= 0 && 'sessionId' in data) {
        root.nodes[index] = { ...root.nodes[index], sessionId: data.sessionId };
      }
      return;
    }
    if (event.kind === 'runtime_replaced') {
      const index = root.nodes.findIndex((candidate) => sameAgentPath(candidate.path, event.path));
      const replacement = event.data as { newSessionId: string };
      if (index >= 0) root.nodes[index] = { ...root.nodes[index], sessionId: replacement.newSessionId };
      return;
    }
    if (event.kind === 'node_removed') {
      const removed = event.data as { node: SubagentNodeSnapshot; reason: string };
      const removedPath = removed.node.path;
      const notice: SubagentViewClosedNotice = {
        rootSessionId: root.rootSessionId,
        path: copyAgentPath(removedPath),
        reason: 'teardown',
        node: removed.node,
      };
      this.subagentClosedNotices = { ...this.subagentClosedNotices, [this.subagentNoticeKey(root.rootSessionId, removedPath)]: notice };
      this.subagentNoticeVersion += 1;
      root.nodes = root.nodes.filter((node) => !pathStartsWith(removedPath, node.path));
      for (const attachment of Object.values(root.attachments)) {
        if (pathStartsWith(removedPath, attachment.path)) this.closeSubagentAttachment(root, attachment, 'teardown', removed.node);
      }
    }
  }

  /** Apply one authoritative child snapshot. The server sends it ahead of the
   *  open response, so ordering is by cursor and runtime identity alone. */
  private applySubagentViewSnapshot(snapshot: SubagentViewSnapshot): SubagentAttachmentState | null {
    const root = this.ensureSubagentRoot(snapshot.sessionId);
    const key = subagentPathKey(snapshot.path);
    const current = root.attachments[key];
    const rebind = current !== undefined && (current.sessionId !== snapshot.childSessionId || current.incarnation !== snapshot.incarnation);
    if (current && !current.closed && !rebind && snapshot.viewCursor <= current.viewCursor) return current;
    const attachment = current && !rebind ? current : this.createSubagentAttachment(snapshot.sessionId, snapshot);
    attachment.draftText = current?.draftText ?? '';
    attachment.incarnation = snapshot.incarnation;
    attachment.sessionId = snapshot.childSessionId;
    attachment.viewCursor = snapshot.viewCursor;
    attachment.closed = false;
    attachment.closeReason = undefined;
    root.attachments[key] = attachment;
    this.applySessionEvent(attachment, { ...snapshot, type: 'full_resync', sessionId: snapshot.childSessionId });
    return this.getSubagentAttachment(snapshot.sessionId, snapshot.path);
  }

  private applySubagentViewEvent(event: SubagentViewEvent): void {
    const attachment = this.getSubagentAttachment(event.sessionId, event.path);
    if (!attachment || attachment.closed || event.childSessionId !== attachment.sessionId) return;
    if (event.incarnation && attachment.incarnation !== event.incarnation) return;
    const ephemeral = !('cursor' in event.event) || typeof event.event.cursor !== 'number';
    if (event.viewCursor < attachment.viewCursor || (event.viewCursor === attachment.viewCursor && !ephemeral)) return;
    attachment.viewCursor = Math.max(attachment.viewCursor, event.viewCursor);
    this.applySessionEvent(attachment, event.event);
  }

  private applySubagentViewClosed(event: SubagentViewClosedEvent): void {
    const root = this.ensureSubagentRoot(event.sessionId);
    const attachment = root.attachments[subagentPathKey(event.path)];
    if (!attachment) return;
    const node = root.nodes.find((candidate) => sameAgentPath(candidate.path, event.path));
    this.closeSubagentAttachment(root, attachment, event.reason, node);
  }

  /** Route an incoming event to the correct session's state */
  /** Prepend recovered queued messages to a session's draft and show it in the composer. */
  restoreQueuedDrafts(sessionId: string, queued: string[]): void {
    // A full resync can replace the session object while a request is in flight.
    // Read the current snapshot and draft only when restoring.
    const session = this.getSessionState(sessionId);
    if (!session || queued.length === 0) return;
    const recovered = queued.join('\n');
    const text = recovered && session.draftText ? `${recovered}\n${session.draftText}` : recovered || session.draftText;
    this.setDraftText(sessionId, text);
  }

  handleEvent(input: PimoteEvent): void {
    const event = input;
    const sessionId = 'sessionId' in event ? event.sessionId : undefined;

    // buffered_events: iterate root sub-events. Child-view events never enter
    // this envelope and therefore never advance root replay state.
    if (event.type === 'buffered_events') {
      const buffered = event as BufferedEventsEvent;
      for (const subEvent of buffered.events) this.handleEvent(subEvent);
      return;
    }

    // Hierarchy and child surfaces are independent of root URL/session state.
    // Process them before looking up `sessions[sessionId]` so a snapshot that
    // races an open response is not discarded.
    if (event.type === 'subagent_snapshot') {
      this.applySubagentHierarchySnapshot(event as SubagentSnapshotEvent);
      return;
    }
    if (event.type === 'subagent_event') {
      this.applySubagentTopologyEvent(event as Extract<PimoteEvent, { type: 'subagent_event' }>);
      return;
    }
    if (event.type === 'subagent_view_snapshot') {
      this.applySubagentViewSnapshot(event as SubagentViewSnapshot);
      return;
    }
    if (event.type === 'subagent_view_event') {
      this.applySubagentViewEvent(event as SubagentViewEvent);
      return;
    }
    if (event.type === 'subagent_view_closed') {
      this.applySubagentViewClosed(event as SubagentViewClosedEvent);
      return;
    }
    if (!sessionId) return;
    const session = this.getSessionState(sessionId);
    if (session) this.applySessionEvent(session, event);
  }

  private applySessionEvent(session: PerSessionState, event: PimoteEvent): void {
    const sessionId = session.sessionId;
    if (event.type === 'buffered_events') {
      for (const item of event.events) this.applySessionEvent(session, item);
      return;
    }
    if (isSubagentContentEvent(event)) {
      if (applyProjectedEventToStreaming(session, event)) return;
      applyProjectedEventToTranscript(session, event, (count) => this.generateMessageKeys(count));
      session.messageCount = session.messages.length;
      return;
    }

    switch (event.type) {
      case 'connection_restored':
        if (event.state) this.applyRuntimeState(session, event.state);
        break;
      case 'agent_start':
        session.streamingRevision++;
        session.status = 'working';
        session.isStreaming = true;
        break;

      case 'queue_update':
        // The SDK publishes this snapshot before consumed-message events and
        // after clearQueue. Abort responses restore drafts, not live queues.
        session.pendingSteeringMessages = [...(event as QueueUpdateEvent).steering];
        break;

      case 'queued_drafts_restored':
        // Another client aborted the session. Restore only the messages this client sent.
        {
          const drafts = event as QueuedDraftsRestoredEvent;
          this.restoreQueuedDrafts(sessionId, [...drafts.steering, ...drafts.followUp]);
        }
        break;

      case 'auto_retry_end': {
        // success:true is followed immediately by a fresh agent_start for the
        // retried attempt — no-op so the working state doesn't flicker.
        // success:false is the terminal signal we get when a retry is
        // user-aborted during the backoff sleep: the SDK fires no subsequent
        // agent_end in that path (the prior agent_end already went out as
        // willRetry:true, which we intentionally ignored). Without handling
        // this here, isStreaming would stay true forever and the Abort button
        // would appear to do nothing. Treat success:false as terminal.
        const retryEvent = event as AutoRetryEndEvent;
        if (retryEvent.success) break;
        session.streamingRevision++;
        session.status = 'idle';
        session.isStreaming = false;
        this.retainPartialAssistantUsage(session);
        session.streamingMessage = null;
        session.streamingKey = null;
        session.lastPositiveStreamingUsage = null;
        if (!this.userIsLookingAt(sessionId)) {
          session.needsAttention = true;
        }
        break;
      }

      case 'agent_settled': {
        // Authoritative idle boundary: raised only when the session is genuinely
        // quiescent (no active run, retry, auto-compaction, or queued
        // continuation). This — not the terminal `agent_end` — drives the idle
        // status transition, so the UI stays "working" continuously through a
        // retry, compaction, or queued follow-up instead of flickering
        // working→idle→working. Content cleanup (clearing the stray streaming
        // placeholder, entry IDs, meta) happens on `agent_end` below.
        session.streamingRevision++;
        session.status = 'idle';
        session.isStreaming = false;
        // Native recordBashResult() defers persistence while the model is
        // streaming. Promote those completed transient entries only after the
        // SDK's settled boundary, preserving assistant/message ordering.
        this.flushCompletedBash(sessionId);
        // A user-aborted settle needs no attention flag: the abort came from
        // whoever was engaged with the session.
        const settledEvent = event as AgentSettledEvent;
        if (settledEvent.meta) this.updateMeta(sessionId, settledEvent.meta);
        const settledAborted = settledEvent.aborted === true;
        if (!this.userIsLookingAt(sessionId) && !settledAborted) {
          session.needsAttention = true;
        }
        break;
      }

      case 'agent_end': {
        const endEvent = event as AgentEndEvent;
        // A `willRetry` agent_end is not a real end — the SDK detected a
        // retryable error and will re-run the prompt after backoff (a fresh
        // agent_start follows). Skipping it avoids dropping the in-flight
        // streaming message mid-retry. The idle status transition is driven by
        // `agent_settled`, not here — this branch only does per-attempt content
        // cleanup for a genuine (non-retry) end.
        if (endEvent.willRetry) break;
        // Clear any in-flight streaming message. The SDK does not emit message_end
        // for a partial message when a run ends abnormally (e.g. user abort during a
        // thinking block), so without this the streaming placeholder would linger
        // indefinitely and the UI would continue to look "streaming".
        this.retainPartialAssistantUsage(session);
        session.streamingMessage = null;
        session.streamingKey = null;
        session.lastPositiveStreamingUsage = null;
        // Apply entry IDs so navigation targets work on messages received via streaming.
        if (endEvent.messageEntryIds) hydrateMessageEntryIds(session, endEvent.messageEntryIds);
        break;
      }

      case 'turn_end': {
        const turnEnd = event as import('@pimote/shared').TurnEndEvent;
        if (turnEnd.meta) this.updateMeta(sessionId, turnEnd.meta);
        break;
      }

      case 'message_start': {
        const start = event as MessageStartEvent;
        // Our own prompt's echo: its optimistic entry is already displayed.
        if (start.role === 'user' && start.clientMessageId !== undefined && session.optimisticEntries.some((e) => e.clientMessageId === start.clientMessageId)) {
          break;
        }
        // Pi emits a second assistant start with an all-zero usage snapshot for
        // an abort or provider error. Keep the prior positive snapshot until
        // that terminal message can receive the client-only fallback.
        const previousPositiveUsage = session.lastPositiveStreamingUsage;
        this.resetAssistantUsageTracking(session);
        session.streamingKey = 'msg-' + this._nextMessageKey++;
        session.streamingMessage = {
          role: start.role,
          content: [],
          ...(start.customType ? { customType: start.customType } : {}),
          ...(start.display !== undefined ? { display: start.display } : {}),
        };
        if (start.role === 'assistant' && previousPositiveUsage && isZeroUsage(start.usage)) {
          session.lastPositiveStreamingUsage = previousPositiveUsage;
        }
        this.rememberStreamingUsage(session, start.usage);
        break;
      }

      case 'message_update': {
        const update = event as MessageUpdateEvent;
        if (!session.streamingMessage) break;
        if (update.subtype === 'start') {
          const block: PimoteMessageContent = { type: update.content.type, text: '', streaming: true };
          if (update.content.type === 'tool_call') {
            block.toolCallId = update.toolCallId;
            block.toolName = update.toolName;
          }
          session.streamingMessage.content[update.contentIndex] = block;
        } else if (update.subtype === 'delta') {
          const block = session.streamingMessage.content[update.contentIndex];
          if (block) {
            block.text = (block.text ?? '') + update.content.text;
          }
        } else if (update.subtype === 'end') {
          const block = session.streamingMessage.content[update.contentIndex];
          if (block) {
            block.streaming = false;
          }
        }
        this.rememberStreamingUsage(session, update.usage);
        break;
      }

      case 'custom_entry': {
        // Display-only custom entry (pi.appendEntry) with a registered
        // renderer — appended in arrival order; no streaming state involved.
        const entryEvent = event as CustomEntryEvent;
        session.messages = [...session.messages, entryEvent.message];
        session.projectedSubagentContent = projectMessage(session.projectedSubagentContent, entryEvent.message, session.messages.length - 1, session.messages);
        session.messageKeys = [...session.messageKeys, 'msg-' + this._nextMessageKey++];
        session.messageCount++;
        break;
      }

      case 'message_end': {
        const end = event as MessageEndEvent;
        const message: PimoteAgentMessage = end.message;
        const partialUsage = session.lastPositiveStreamingUsage ?? session.pendingAssistantUsage?.usage;
        let insertedKey: string | null = null;
        let projectedIndex: number;

        // Reconcile optimistic entries. The server stamps a started prompt's
        // user echo with the sender's clientMessageId, so our own echo
        // replaces its entry in place. Server events arrive in transcript
        // order, so any other confirmed message (a foreign user message or an
        // assistant turn) belongs ahead of every still-unconfirmed entry.
        const ownEntry =
          message.role === 'user' && end.clientMessageId !== undefined ? session.optimisticEntries.find((e) => e.clientMessageId === end.clientMessageId) : undefined;
        const ownIdx = ownEntry ? session.messageKeys.indexOf(ownEntry.key) : -1;
        if (ownEntry && ownIdx !== -1) {
          const newMessages = [...session.messages];
          newMessages[ownIdx] = message;
          session.messages = newMessages;
          projectedIndex = ownIdx;
          session.optimisticEntries = session.optimisticEntries.filter((e) => e !== ownEntry);
          // The echo's message_start was skipped, so no placeholder exists for
          // it. Clear streaming state only for a user placeholder from an
          // unskipped start — never an assistant placeholder streaming across
          // a mid-run user echo (steering).
          if (session.streamingMessage?.role === 'user') {
            session.streamingMessage = null;
            session.streamingKey = null;
          }
        } else {
          // Untrack entries whose key is gone (key desync): they must not
          // shift insert positions. A resync rebuild repairs the transcript.
          session.optimisticEntries = session.optimisticEntries.filter((e) => session.messageKeys.includes(e.key));
          const insertIdx = session.optimisticEntries.length > 0 ? session.messageKeys.indexOf(session.optimisticEntries[0].key) : session.messages.length;
          session.messages = [...session.messages.slice(0, insertIdx), message, ...session.messages.slice(insertIdx)];
          // Always place a key in lockstep with messages. If streamingKey is
          // null here (e.g. agent_end cleared it before message_end, or
          // message_end arrived without a preceding message_start), falling
          // through without a key would desync messages/messageKeys by 1 and
          // poison this session — every subsequent optimistic-user reconcile
          // would resolve to the wrong index, clobbering the previous
          // assistant message and duplicating the user message in the UI.
          const key = session.streamingKey ?? 'msg-' + this._nextMessageKey++;
          insertedKey = key;
          if (!session.streamingKey) {
            console.error('[session-desync] message_end without streamingKey', {
              sessionId,
              cursor: end.cursor,
              role: message.role,
              messagesLen: session.messages.length,
              keysLen: session.messageKeys.length,
            });
          }
          session.messageKeys = [...session.messageKeys.slice(0, insertIdx), key, ...session.messageKeys.slice(insertIdx)];
          projectedIndex = insertIdx;
          session.streamingMessage = null;
          session.streamingKey = null;
        }
        if (message.role === 'assistant') {
          if (!hasPositiveUsage(message.usage) && (message.aborted === true || message.errorMessage !== undefined) && insertedKey && partialUsage) {
            this.storeAssistantUsageOverride(session, insertedKey, partialUsage);
          }
          session.lastPositiveStreamingUsage = null;
          session.pendingAssistantUsage = null;
        }
        session.messageCount++;
        // Capture firstMessage from first user message
        if (message.role === 'user' && session.firstMessage === undefined) {
          const textContent = message.content.find((c: PimoteMessageContent) => c.type === 'text');
          if (textContent && textContent.text) {
            session.firstMessage = textContent.text;
          }
        }
        // toolResult messages carry the canonical completion data — update toolExecutions
        if (message.role === 'toolResult') {
          this.applyToolResults(session, message);
        }
        session.projectedSubagentContent = projectMessage(session.projectedSubagentContent, message, projectedIndex, session.messages);
        break;
      }

      case 'bash_execution_update': {
        this.updateBash(sessionId, event as BashExecutionUpdateEvent);
        break;
      }

      case 'tool_execution_start': {
        const start = event as ToolExecutionStartEvent;
        session.toolExecutions[start.toolCallId] = {
          name: start.toolName,
          args: start.args,
          partialResult: '',
          status: 'running',
        };
        break;
      }

      case 'tool_execution_update': {
        const upd = event as ToolExecutionUpdateEvent;
        const call = session.toolExecutions[upd.toolCallId];
        if (call && call.partialResult.length < MAX_TOOL_PARTIAL_CHARS) {
          const remaining = MAX_TOOL_PARTIAL_CHARS - call.partialResult.length;
          call.partialResult += upd.content.slice(0, remaining);
        }
        break;
      }

      case 'tool_execution_end': {
        const end = event as ToolExecutionEndEvent;
        const call = session.toolExecutions[end.toolCallId];
        if (call) {
          call.status = 'completed';
          // The wire end event carries the full SDK AgentToolResult
          // ({content, details, structuredContent}); reduce it to display text
          // plus the structured payload so live and replayed rendering match.
          const reduced = reduceEndEventResult(end.result);
          call.result = reduced.text;
          if (reduced.data !== undefined) call.data = reduced.data;
          call.isError = end.isError;
          if (end.durationMs !== undefined) call.durationMs = end.durationMs;
        }
        break;
      }

      case 'auto_compaction_start':
        session.isCompacting = true;
        break;

      case 'auto_compaction_end': {
        session.isCompacting = false;
        const compacted = event as import('@pimote/shared').AutoCompactionEndEvent;
        if (compacted.meta) this.updateMeta(sessionId, compacted.meta);
        break;
      }

      case 'tree_navigation_start':
        session.isNavigatingTree = true;
        session.treeNavigationSummarizing = (event as TreeNavigationStartEvent).summarizing;
        break;

      case 'tree_navigation_end':
        session.isNavigatingTree = false;
        session.treeNavigationSummarizing = false;
        break;

      case 'full_resync': {
        const resync = event as FullResyncEvent;
        this.clearBashOutputBytes(sessionId);
        const state: SessionState = resync.state;
        const messages: PimoteAgentMessage[] = resync.messages;
        const rebuilt = this.createSessionState(session.sessionId, session.folderPath, session.projectName);
        rebuilt.draftText = session.draftText;
        rebuilt.extensionTitle = session.extensionTitle;
        rebuilt.restoreMode = session.restoreMode;
        rebuilt.isRestoring = session.isRestoring;
        rebuilt.folder = session.folder;
        rebuilt.contextUsage = session.contextUsage;
        rebuilt.lifetimeCostUsd = session.lifetimeCostUsd;
        if (session.usageBreakdown !== undefined) {
          rebuilt.usageBreakdown = session.usageBreakdown;
        }
        rebuilt.gitBranch = session.gitBranch;
        rebuilt.pendingSteeringMessages = [...(resync.pendingSteeringMessages ?? session.pendingSteeringMessages)];
        // Don't carry over panelCards — server will send panel_update if panels are active.
        // Carrying over stale cards causes ghost panels after agent teardown + reconnect.
        // widgetCards get the same treatment: unlike panel cards there is no server-side
        // widget snapshot that could correct stale entries, so carrying them over keeps
        // ghost widgets alive forever (a clear emitted while this client was disconnected
        // is unrecoverable). Extensions re-emit live widgets as setWidget events after a
        // reset.
        rebuilt.model = state.model;
        rebuilt.thinkingLevel = state.thinkingLevel;
        rebuilt.availableThinkingLevels = state.availableThinkingLevels;
        rebuilt.isStreaming = state.isStreaming;
        rebuilt.isCompacting = state.isCompacting;
        rebuilt.isNavigatingTree = state.isNavigatingTree ?? false;
        rebuilt.treeNavigationSummarizing = state.treeNavigationSummarizing ?? false;
        rebuilt.autoCompactionEnabled = state.autoCompactionEnabled;
        rebuilt.messageCount = state.messageCount;
        rebuilt.sessionFile = state.sessionFile;
        rebuilt.sessionName = state.sessionName ?? null;
        rebuilt.projectedSubagentContent = hydrateSubagentContent(messages, resync.activeSubagentContent ?? []);
        rebuilt.messages = [...rebuilt.projectedSubagentContent.messages];
        rebuilt.branchEntryIds = resync.branchEntryIds !== undefined ? [...resync.branchEntryIds] : undefined;
        rebuilt.firstMessage = this.firstUserMessage(messages);
        rebuilt.status = state.isStreaming ? 'working' : 'idle';
        rebuilt.messageKeys = this.generateMessageKeys(messages.length);
        this.rebuildToolExecutions(rebuilt);
        if (resync.streamingMessage) {
          // The in-flight message: later deltas extend its last block.
          const blocks = resync.streamingMessage.content;
          rebuilt.streamingKey = 'msg-' + this._nextMessageKey++;
          rebuilt.streamingMessage = {
            ...resync.streamingMessage,
            content: blocks.map((block, i) => ({ ...block, streaming: i === blocks.length - 1 })),
          };
          if (rebuilt.streamingMessage.role === 'assistant' && hasPositiveUsage(rebuilt.streamingMessage.usage)) {
            rebuilt.lastPositiveStreamingUsage = rebuilt.streamingMessage.usage;
          }
        }
        for (const toolCallId of resync.runningToolCallIds ?? []) {
          const call = this.findToolCall(rebuilt, toolCallId);
          rebuilt.toolExecutions[toolCallId] = { name: call?.toolName ?? '', args: call?.args, partialResult: '', status: 'running' };
        }
        if ('rootSessionId' in session) {
          const child = session as SubagentAttachmentState;
          this.subagentRoots[child.rootSessionId].attachments[subagentPathKey(child.path)] = { ...child, ...rebuilt };
        } else {
          this.sessions[sessionId] = rebuilt;
        }
        break;
      }

      case 'session_restore': {
        const restore = event as SessionRestoreEvent;
        session.restoreMode = restore.status === 'started' ? restore.mode : null;
        session.isRestoring = restore.status === 'started';
        break;
      }

      case 'session_conflict': {
        const conflict = event as SessionConflictEvent;
        session.conflictingProcesses = conflict.processes;
        break;
      }

      case 'session_state_changed': {
        const changed = event as SessionStateChangedEvent;
        if (changed.sessionName !== undefined) {
          session.sessionName = changed.sessionName || null;
        }
        if (changed.gitBranch !== undefined) {
          for (const candidate of Object.values(this.sessions)) {
            if (candidate.folderPath === changed.folderPath) {
              candidate.gitBranch = changed.gitBranch;
            }
          }
        }
        break;
      }

      case 'session_settings_changed': {
        const settings = event as SessionSettingsChangedEvent;
        session.model = settings.model;
        session.thinkingLevel = settings.thinkingLevel;
        session.availableThinkingLevels = settings.availableThinkingLevels;
        session.autoCompactionEnabled = settings.autoCompactionEnabled;
        break;
      }

      case 'session_renamed': {
        session.sessionName = (event as SessionRenamedEvent).name;
        break;
      }

      case 'panel_update': {
        session.panelCards = (event as PanelUpdateEvent).cards;
        if (sessionId === this.viewedSessionId) {
          this.syncViewedPanelStore();
        }
        break;
      }

      case 'download_update': {
        const update = event as DownloadUpdateEvent;
        // Every update is a complete replacement snapshot. Copy the array so
        // subsequent protocol-object mutation cannot leak into this session's
        // reactive state, then notify presentation after reduction so it can
        // inspect the authoritative pending list.
        session.downloads = [...update.downloads];
        this.onDownloadUpdate?.(update);
        break;
      }

      case 'pimote_navigate': {
        // Only honor navigation for the currently viewed session — don't
        // yank the user away if a background session emits this.
        if (sessionId === this.viewedSessionId) {
          const url = (event as NavigateEvent).url;
          if (typeof url === 'string' && url.length > 0) {
            // Static-host navigation is intentionally new-tab only. A popup
            // blocker can suppress it; the sidebar card remains available.
            window.open(url, '_blank', 'noopener,noreferrer');
          }
        }
        break;
      }
    }

    // Update last bot activity timestamp from server-side timestamp
    if ('timestamp' in event && typeof (event as Record<string, unknown>).timestamp === 'string') {
      session.lastBotActivityTimestamp = (event as Record<string, unknown>).timestamp as string;
    }
  }

  private combinedPanelCards(session: PerSessionState | null): Card[] {
    if (!session) return [];
    return [...session.panelCards, ...Object.values(session.widgetCards)];
  }

  syncViewedPanelStore(): void {
    panelStore.handlePanelUpdate(this.combinedPanelCards(this.viewed));
  }

  /** Add a session to the registry. If it already exists, resets it. Lifecycle pushes upsert separately. */
  addSession(sessionId: string, folderPath: string, projectName: string): void {
    this.clearBashOutputBytes(sessionId);
    this.sessions[sessionId] = this.createSessionState(sessionId, folderPath, projectName);
  }

  /** Mark a tracked session as restorable or keep its transcript out of reconnect restores. */
  setRestorable(sessionId: string, restorable: boolean): void {
    const session = this.sessions[sessionId];
    if (!session || session.restorable === restorable) return;
    session.restorable = restorable;
  }

  /** Patch a session's folder once it becomes known — a folderless deep-link open resolves it server-side. */
  setSessionFolder(sessionId: string, folderPath: string): void {
    const session = this.sessions[sessionId];
    if (!session || session.folderPath === folderPath) return;
    session.folderPath = folderPath;
    session.projectName = folderPath.split('/').pop() || 'Unknown';
  }

  /** Point a session at its folder object — the folder model's canonical
   *  row when a resolver is bound, else the wire row as-is. Called at every
   *  wire moment a session identity is created (session_opened,
   *  session_replaced). */
  bindSessionFolder(sessionId: string, folder: FolderInfo): void {
    const session = this.sessions[sessionId];
    if (!session) return;
    session.folder = this.folderObjectResolver ? this.folderObjectResolver(folder) : folder;
  }

  private removeSessionEntry(sessionId: string): boolean {
    this.clearBashOutputBytes(sessionId);
    this.clearSubagentRoot(sessionId);
    // A session removal has no download_update event to reconcile against;
    // explicitly drop any queued one-shot actions owned by that session.
    downloadUi.clearSession(sessionId);
    if (!this.sessions[sessionId]) return false;
    // Reassign rather than delete to reliably trigger Svelte 5 $state reactivity
    const { [sessionId]: _, ...rest } = this.sessions;
    this.sessions = rest;
    // The actor of a close is not echoed, so the local facts drop the id here.
    if (this.selectedSessionId === sessionId) this.selectedSessionId = null;
    if (this.sessionOrder.includes(sessionId)) this.sessionOrder = this.sessionOrder.filter((id) => id !== sessionId);
    return true;
  }

  /** Remove a session from the registry without changing the current view. */
  removeSessionQuietly(sessionId: string): void {
    this.removeSessionEntry(sessionId);
  }

  /** Remove a session from the registry. */
  removeSession(sessionId: string): void {
    const wasViewed = this.viewedSessionId === sessionId;
    this.removeSessionEntry(sessionId);
    if (wasViewed) {
      // Switch to another active session if one exists, otherwise go to landing
      const remaining = this.activeSessions.map((session) => session.sessionId);
      this.viewedSessionId = remaining.length > 0 ? remaining[0] : null;
      this.syncViewedPanelStore();
      this.navigateToViewed(true);
    }
  }

  /** Replace a session in-place — same slot in the registry, new session ID.
   *  Used when the underlying pi session resets (newSession, fork, switchSession). */
  replaceSession(oldSessionId: string, newSessionId: string, folderPath: string, projectName: string): void {
    const old = this.sessions[oldSessionId];
    if (!old) return;
    // A root replacement closes the provider host. Child paths belong to the
    // old root identity and must not leak into the new root slot.
    this.clearSubagentRoot(oldSessionId);

    // A reset/replacement creates a new session identity and does not migrate
    // one-shot registrations or their actionable toasts.
    this.clearBashOutputBytes(oldSessionId);
    this.clearBashOutputBytes(newSessionId);
    downloadUi.clearSession(oldSessionId);

    // Remove old entry, add new entry with clean state but same slot identity
    const { [oldSessionId]: _, ...rest } = this.sessions;
    const next = this.createSessionState(newSessionId, folderPath, projectName);
    next.model = old.model;
    next.thinkingLevel = old.thinkingLevel;
    next.availableThinkingLevels = old.availableThinkingLevels;
    next.autoCompactionEnabled = old.autoCompactionEnabled;
    next.gitBranch = old.gitBranch;
    rest[newSessionId] = next;
    this.sessions = rest;

    // A rekeyed session keeps its chip slot and its selection: the order names
    // the identity that replaced the old one.
    if (this.sessionOrder.includes(oldSessionId)) {
      this.sessionOrder = this.sessionOrder.map((id) => (id === oldSessionId ? newSessionId : id));
    }
    if (this.selectedSessionId === oldSessionId) this.selectedSessionId = newSessionId;

    // If the old session was being viewed, view the new one
    if (this.viewedSessionId === oldSessionId) {
      this.viewedSessionId = newSessionId;
      this.syncViewedPanelStore();
      this.navigateToViewed(true);
    }
  }

  /** Switch viewed session, clears needsAttention for target */
  switchTo(sessionId: string, opts?: { replace?: boolean }): void {
    this.viewedSessionId = sessionId;
    const session = this.sessions[sessionId];
    if (session) {
      session.needsAttention = false;
    }
    this.syncViewedPanelStore();
    this.navigateToViewed(opts?.replace ?? false);
  }

  /** Attention is user-level (D3): a session this user already looks at from
   *  any connection needs none. */
  private userIsLookingAt(sessionId: string): boolean {
    return sessionId === this.viewedConversation?.sessionId || sessionId === this.selectedSessionId;
  }

  /** Leave the conversation view and return to the dashboard (viewedSessionId = null). */
  goHome(opts?: { replace?: boolean }): void {
    this.viewedSessionId = null;
    this.syncViewedPanelStore();
    this.navigateToViewed(opts?.replace ?? false);
  }

  /**
   * Adopt a session id arriving from the URL (route param) without re-navigating —
   * the browser is already at /sessions/<id>. Returns false for unknown ids so the
   * route page can redirect home (stale deep links).
   */
  adoptRouteView(sessionId: string): boolean {
    if (!this.isActiveSession(sessionId)) return false;
    this.clearViewNavigation();
    if (this.viewedSessionId === sessionId) return true;
    this.viewedSessionId = sessionId;
    this.syncViewedPanelStore();
    return true;
  }

  /**
   * Adopt the home route arrived from the URL (back/forward) without
   * re-navigating — the browser is already at '/'. Mirror of adoptRouteView:
   * only the session route adopts its param, so history navigation back to
   * the dashboard would otherwise leave viewedSessionId set and keep
   * session-scoped layout chrome (extension status bar, mobile header)
   * visible on the home page.
   */
  adoptHomeRoute(): void {
    this.clearViewNavigation();
    if (this.viewedSessionId === null) return;
    this.viewedSessionId = null;
    this.syncViewedPanelStore();
  }

  /** Check if a session ID has a live server attachment. */
  isActiveSession(sessionId: string): boolean {
    return this.sessions[sessionId]?.restorable === true;
  }

  /** Update session meta (git branch, context usage, lifetime cost) */
  /** Return row usage, including an active-view-only terminal partial fallback. */
  getAssistantRowUsage(sessionId: string, messageIndex: number, toolResultUsageIndex?: ToolResultUsageIndex): import('@pimote/shared').AssistantRowUsage | null {
    const session = this.getSessionState(sessionId);
    const message = session?.messages[messageIndex];
    if (!session || !message || message.role !== 'assistant') return null;

    const key = session.messageKeys[messageIndex];
    const fallback = key ? session.assistantUsageOverrides[key] : undefined;
    const snapshot = !hasPositiveUsage(message.usage) && fallback ? { ...message, usage: fallback } : message;
    const usage = sessionId === this.viewedConversation?.sessionId ? snapshot : message;
    return summarizeAssistantRowUsage(usage, session.messages, toolResultUsageIndex);
  }

  updateMeta(sessionId: string, meta: SessionMeta): void {
    const session = this.getSessionState(sessionId);
    if (!session) return;

    // Context usage and lifetime cost are session-specific, but git branch is
    // repository-level. Keep branch labels in sync for all sessions under the
    // same folder.
    session.contextUsage = meta.contextUsage;
    session.lifetimeCostUsd = meta.lifetimeCostUsd;
    if (meta.usageBreakdown === undefined) {
      delete session.usageBreakdown;
    } else {
      session.usageBreakdown = meta.usageBreakdown;
    }
    for (const candidate of Object.values(this.sessions)) {
      if (candidate.folderPath === session.folderPath) {
        candidate.gitBranch = meta.gitBranch;
      }
    }
  }

  /** Apply a toolResult message to toolExecutions — marks the tool as completed with its result */
  private applyToolResults(session: PerSessionState, message: PimoteAgentMessage): void {
    for (const block of message.content) {
      if (block.type === 'tool_result' && block.toolCallId) {
        const existing = session.toolExecutions[block.toolCallId];
        if (existing) {
          // Replace incrementally-accumulated data with canonical result
          existing.status = 'completed';
          existing.result = block.result;
          existing.data = block.data;
          existing.images = block.images;
          existing.isError = block.isError;
        } else {
          // Rehydration: no prior execution state, create from the result
          session.toolExecutions[block.toolCallId] = {
            name: block.toolName ?? 'unknown',
            args: undefined,
            partialResult: '',
            status: 'completed',
            result: block.result,
            data: block.data,
            images: block.images,
            isError: block.isError,
          };
        }
      }
    }
  }

  /** Rebuild toolExecutions from a full message history (for rehydration) */
  /** The tool_call block for `toolCallId`, searched from the newest message. */
  private findToolCall(session: PerSessionState, toolCallId: string): PimoteMessageContent | undefined {
    return (
      session.streamingMessage?.content.find((content) => content.type === 'tool_call' && content.toolCallId === toolCallId) ?? findToolCallInMessages(session.messages, toolCallId)
    );
  }

  rebuildToolExecutions(session: PerSessionState): void {
    session.toolExecutions = rebuildToolExecutionsFromMessages(session.messages);
  }

  /** Begin tracking a caller-owned native bash execution. */
  startBash(sessionId: string, execution: Pick<BashExecutionState, 'id' | 'command' | 'excludeFromContext'>): void {
    const session = this.getSessionState(sessionId);
    if (!session) return;

    this.bashOutputBytes.set(this.bashOutputKey(sessionId, execution.id), 0);
    session.bashExecutions = {
      ...session.bashExecutions,
      [execution.id]: {
        id: execution.id,
        command: execution.command,
        excludeFromContext: execution.excludeFromContext,
        output: '',
        status: 'running',
      },
    };
  }

  /** Apply one live SDK bash output update to its transient execution. */
  updateBash(sessionId: string, update: Pick<BashExecutionUpdateEvent, 'id' | 'delta'>): void {
    const session = this.getSessionState(sessionId);
    if (!session) return;

    let targetId = update.id;
    if (!targetId) {
      const runningIds = Object.values(session.bashExecutions)
        .filter((execution) => execution.status === 'running')
        .map((execution) => execution.id);
      if (runningIds.length !== 1) return;
      targetId = runningIds[0];
    }

    const execution = session.bashExecutions[targetId];
    if (!execution || execution.status !== 'running') return;

    const outputKey = this.bashOutputKey(sessionId, targetId);
    const bounded = appendBoundedBashOutput(execution.output, update.delta, MAX_BASH_LIVE_OUTPUT_BYTES, this.bashOutputBytes.get(outputKey));
    this.bashOutputBytes.set(outputKey, bounded.bytes);
    session.bashExecutions = {
      ...session.bashExecutions,
      [targetId]: {
        ...execution,
        output: bounded.output,
        ...(execution.outputTruncated || bounded.truncated ? { outputTruncated: true } : {}),
      },
    };
  }

  private appendBashMessage(session: PerSessionState, execution: BashExecutionState, result: BashResult): void {
    const message: PimoteAgentMessage = {
      role: 'bashExecution',
      content: [{ type: 'text', text: `$ ${execution.command}\n${result.output}` }],
      command: execution.command,
      output: result.output,
      cancelled: result.cancelled,
      truncated: result.truncated,
      excludeFromContext: execution.excludeFromContext,
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      ...(result.fullOutputPath !== undefined ? { fullOutputPath: result.fullOutputPath } : {}),
    };

    const key = 'msg-' + this._nextMessageKey++;
    session.messages = [...session.messages, message];
    session.messageKeys = [...session.messageKeys, key];
    session.messageCount++;
  }

  /** Promote completed entries once the SDK's model turn has settled. */
  private flushCompletedBash(sessionId: string): void {
    const session = this.getSessionState(sessionId);
    if (!session || session.isStreaming) return;

    const completed = Object.values(session.bashExecutions).filter((execution) => execution.status === 'complete' || execution.status === 'cancelled');
    if (completed.length === 0) return;

    const remaining = { ...session.bashExecutions };
    for (const execution of completed) {
      if (!execution.result) continue;
      this.appendBashMessage(session, execution, execution.result);
      delete remaining[execution.id];
      this.bashOutputBytes.delete(this.bashOutputKey(sessionId, execution.id));
    }
    session.bashExecutions = remaining;
  }

  /** Promote a successful native result to the message list and remove its transient state. */
  completeBash(sessionId: string, id: string, result: BashResult): void {
    const session = this.getSessionState(sessionId);
    const execution = session?.bashExecutions[id];
    if (!session || !execution) return;
    this.bashOutputBytes.delete(this.bashOutputKey(sessionId, id));

    // If the model is still streaming, retain a completed transient entry until
    // agent_settled. Pi queues the native history entry until that same boundary;
    // appending it now would place it before the active assistant message and
    // shift positional navigation targets.
    const completed: BashExecutionState = {
      ...execution,
      output: result.output,
      status: result.cancelled ? 'cancelled' : 'complete',
      result,
      ...(execution.outputTruncated ? { outputTruncated: false } : {}),
    };
    if (session.isStreaming) {
      session.bashExecutions = { ...session.bashExecutions, [id]: completed };
      return;
    }

    this.appendBashMessage(session, completed, result);
    const { [id]: _removed, ...remaining } = session.bashExecutions;
    session.bashExecutions = remaining;
    this.bashOutputBytes.delete(this.bashOutputKey(sessionId, id));
  }

  /** Retain a failed dispatch as a visible, non-context transient entry. */
  failBash(sessionId: string, id: string, error: string): void {
    const session = this.getSessionState(sessionId);
    const execution = session?.bashExecutions[id];
    if (!session || !execution) return;
    this.bashOutputBytes.delete(this.bashOutputKey(sessionId, id));

    session.bashExecutions = {
      ...session.bashExecutions,
      [id]: {
        ...execution,
        status: 'error',
        error,
      },
    };
  }

  /** Drop transient bash state, e.g. after a full resync or session close. */
  clearBash(sessionId: string): void {
    const session = this.getSessionState(sessionId);
    if (!session) return;
    this.clearBashOutputBytes(sessionId);
    session.bashExecutions = {};
  }

  /** Whether a session has a bash outcome that still needs reconciliation. */
  hasPendingBash(sessionId: string): boolean {
    const session = this.getSessionState(sessionId);
    return session ? Object.values(session.bashExecutions).some((execution) => execution.status !== 'error') : false;
  }

  /** Clear conflicting processes for a session (after user dismisses or kills them) */
  clearConflict(sessionId: string): void {
    const session = this.sessions[sessionId];
    if (session) {
      session.conflictingProcesses = [];
    }
  }

  /** Adopt the server's open-view set: close views the user dropped, attach
   *  views this client does not already observe. */
  applyUserViews(views: readonly UserOpenViewRef[]): void {
    this.userViews = views.map((view) => ({ ...view, path: [...view.path] }));
    this.reconcileUserViews(false);
  }

  /** Re-attach every view the user holds open. Socket death detaches this
   *  client's observers, so a locally open attachment proves nothing until the
   *  server answers a fresh open. */
  restoreUserViews(): void {
    this.reconcileUserViews(true);
  }

  private reconcileUserViews(reattach: boolean): void {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local predicate set, never rendered
    const desired = new Set(this.userViews.map((view) => `${view.rootSessionId}\u0000${subagentPathKey(view.path)}`));
    for (const root of Object.values(this.subagentRoots)) {
      for (const [key, attachment] of Object.entries(root.attachments)) {
        if (attachment.closed) continue;
        if (desired.has(`${root.rootSessionId}\u0000${key}`)) continue;
        if (this.pendingSubagentOpens.has(`${attachment.rootSessionId}\u0000${key}`)) continue;
        void this.closeSubagentView(root.rootSessionId, attachment.path);
      }
    }
    for (const view of this.userViews) {
      if (!this.sessions[view.rootSessionId]) continue;
      const attachment = this.getSubagentAttachment(view.rootSessionId, view.path);
      if (!reattach && attachment && !attachment.closed) continue;
      void this.openSubagentView(view.rootSessionId, view.path, false);
    }
  }

  /** Open one child view. The transcript arrives as view frames ahead of the
   *  response, so the attachment exists by the time the response lands. */
  openSubagentView(rootSessionId: string, path: AgentPath, select = true): Promise<SubagentAttachmentState | null> {
    const key = `${rootSessionId}\u0000${subagentPathKey(path)}`;
    const previous = this.getSubagentAttachment(rootSessionId, path);
    const pendingBash = previous ? this.hasPendingBash(previous.sessionId) : false;
    const running = this.pendingSubagentOpens.get(key);
    if (running) return running;
    // The attachment's cursor is what this client actually applied; the wire
    // cursor can run ahead of it when an event was rejected on identity.
    const viewCursor = this.getSubagentAttachment(rootSessionId, path)?.viewCursor;
    const operation = connection
      .send({
        type: 'subagent_open_view',
        sessionId: rootSessionId,
        path: copyAgentPath(path),
        ...(viewCursor !== undefined ? { viewCursor } : {}),
      })
      .then(async (response) => {
        if (!response.success) {
          if (response.error === 'subagent_view_unavailable') this.markSubagentViewUnavailable(rootSessionId, path);
          return null;
        }
        const attachment = this.getSubagentAttachment(rootSessionId, path);
        if (!attachment || attachment.closed) return null;
        if (select) this.selectSubagentView(rootSessionId, attachment.path);
        applyOpenSessionData(attachment.sessionId, (response.data as Pick<OpenSessionResponseData, 'meta' | 'commands'>) ?? {});
        if (pendingBash) void fetchFullSessionData(attachment.sessionId);

        return attachment;
      })
      .catch((error) => {
        console.error('[SessionRegistry] Failed to open child view:', error);
        return null;
      })
      .finally(() => {
        if (this.pendingSubagentOpens.get(key) === operation) this.pendingSubagentOpens.delete(key);
      });
    this.pendingSubagentOpens.set(key, operation);
    return operation;
  }

  /** The server holds no view for this path. Drop the local ghost and forget
   *  the user's stale entry so the open set converges. */
  private markSubagentViewUnavailable(rootSessionId: string, path: AgentPath): void {
    const root = this.subagentRoots[rootSessionId];
    const attachment = root?.attachments[subagentPathKey(path)];
    if (root && attachment && !attachment.closed) this.closeSubagentAttachment(root, attachment, 'unavailable');
    void connection.send({ type: 'subagent_close_view', sessionId: rootSessionId, path: copyAgentPath(path) } as PimoteCommand).catch(() => undefined);
  }

  /** Release one child surface while retaining its transcript and draft for a
   * later explicit reopen. */
  async closeSubagentView(rootSessionId: string, path: AgentPath): Promise<boolean> {
    const attachment = this.getSubagentAttachment(rootSessionId, path);
    if (!attachment || attachment.closed) return false;
    try {
      const response = await connection.send({
        type: 'subagent_close_view',
        sessionId: rootSessionId,
        path: attachment.path,
      });
      if (!response.success) return false;
      const root = this.subagentRoots[rootSessionId];
      if (root) this.closeSubagentAttachment(root, attachment, 'released');
      if (sameAgentPath(this.getSelectedSubagentPath(rootSessionId), path)) this.selectSubagentView(rootSessionId, null);
      return true;
    } catch (error) {
      console.error('[SessionRegistry] Failed to close child view:', error);
      return false;
    }
  }

  async teardownSubagentView(rootSessionId: string, path: AgentPath, incarnation: string): Promise<PimoteResponse> {
    return connection.send({
      type: 'subagent_teardown',
      sessionId: rootSessionId,
      path: copyAgentPath(path),
      incarnation,
    } as PimoteCommand);
  }

  async stopSubagent(rootSessionId: string, path: AgentPath, incarnation: string, expectedSessionId: string): Promise<PimoteResponse> {
    return connection.send({
      type: 'subagent_stop',
      sessionId: rootSessionId,
      path: copyAgentPath(path),
      incarnation,
      expectedSessionId,
    });
  }

  async resurrectSubagent(request: {
    rootSessionId: string;
    savedSessionId: string;
    parentPath: AgentPath;
    localId: string;
    task: string;
    channels: readonly string[];
    model?: string;
  }): Promise<PimoteResponse> {
    return connection.send({
      type: 'subagent_resurrect',
      sessionId: request.rootSessionId,
      savedSessionId: request.savedSessionId,
      parentPath: copyAgentPath(request.parentPath),
      localId: request.localId,
      task: request.task,
      channels: [...request.channels],
      ...(request.model !== undefined && request.model.trim() ? { model: request.model.trim() } : {}),
    } as PimoteCommand);
  }

  /** Dispatch to a session. Only the borrowed-view address differs. */
  async sendSurfaceCommand(sessionId: string, command: Record<string, unknown>): Promise<PimoteResponse> {
    const session = this.getSessionState(sessionId);
    if (!session) throw new Error('session view is closed');
    const { sessionId: _sessionId, path: _path, incarnation: _incarnation, type, ...payload } = command;
    const child = 'rootSessionId' in session ? (session as SubagentAttachmentState) : null;
    const streamingRevision = session.streamingRevision;
    const response = await connection.send({
      ...payload,
      type: child ? `subagent_${String(type)}` : type,
      sessionId: child?.rootSessionId ?? session.sessionId,
      ...(child ? { path: child.path, incarnation: child.incarnation } : {}),
      ...(child && type === 'abort' ? { expectedSessionId: child.sessionId } : {}),
    } as PimoteCommand);
    this.applySurfaceCommandResponse(sessionId, String(type), response, session, streamingRevision);
    return response;
  }

  private applyRuntimeState(session: PerSessionState, state: SessionState): void {
    const { sessionId: _sessionId, ...runtime } = state;
    Object.assign(session, runtime, {
      model: state.model ? { ...state.model } : null,
      availableThinkingLevels: [...state.availableThinkingLevels],
      sessionName: state.sessionName ?? null,
      status: state.isStreaming ? 'working' : 'idle',
    });
  }

  private applySurfaceCommandResponse(sessionId: string, commandType: string, response: PimoteResponse, requestedSession: PerSessionState, streamingRevision: number): void {
    const session = this.getSessionState(sessionId);
    if (!session || !response.data || typeof response.data !== 'object') return;
    const data = response.data as Record<string, unknown>;
    if (
      (commandType === 'abort' || commandType === 'dequeue_steering') &&
      Array.isArray(data.steering) &&
      data.steering.every((text) => typeof text === 'string') &&
      Array.isArray(data.followUp) &&
      data.followUp.every((text) => typeof text === 'string')
    ) {
      this.restoreQueuedDrafts(sessionId, [...data.steering, ...data.followUp]);
      if (commandType === 'dequeue_steering') session.pendingSteeringMessages = [];
    }
    if (!response.success) return;
    if (data.state && typeof data.state === 'object') {
      const state = data.state as SessionState;
      const current = session === requestedSession && session.streamingRevision === streamingRevision;
      this.applyRuntimeState(session, { ...state, isStreaming: current ? state.isStreaming : session.isStreaming });
    }
    if ('model' in data) session.model = data.model as SessionState['model'];
    if (typeof data.thinkingLevel === 'string') session.thinkingLevel = data.thinkingLevel;
    if (Array.isArray(data.availableThinkingLevels)) session.availableThinkingLevels = [...data.availableThinkingLevels] as string[];
    if ((commandType === 'set_thinking_level' || commandType === 'cycle_thinking_level') && typeof data.level === 'string') session.thinkingLevel = data.level;
    if (commandType === 'set_auto_compaction' && typeof data.enabled === 'boolean') session.autoCompactionEnabled = data.enabled;
    if (commandType === 'get_session_meta' && data.meta && typeof data.meta === 'object') this.updateMeta(sessionId, data.meta as SessionMeta);
    if (commandType === 'get_messages' && Array.isArray(data.messages)) {
      this.clearBash(sessionId);
      this.clearAssistantUsageTracking(sessionId);
      session.projectedSubagentContent = hydrateSubagentContent(data.messages as PimoteAgentMessage[], session.projectedSubagentContent.active);
      session.messages = [...session.projectedSubagentContent.messages];
      session.messageKeys = this.generateMessageKeys(session.messages.length);
      session.messageCount = session.messages.length;
      session.firstMessage = this.firstUserMessage(session.messages);
      this.rebuildToolExecutions(session);
    }
    if (commandType === 'get_commands' && Array.isArray(data.commands)) commandStore.setCommands(sessionId, data.commands as CommandInfo[]);
  }
}

// Create singleton instance — fields are reactive via $state() runes above
export const sessionRegistry = new SessionRegistry((event) => {
  coordinateDownloadUpdate(event, downloadUi);
});

function applyOpenSessionData(sessionId: string, data: Pick<OpenSessionResponseData, 'meta' | 'commands'>): void {
  if (data.meta) sessionRegistry.updateMeta(sessionId, data.meta);
  if (data.commands) commandStore.setCommands(sessionId, data.commands);
}

async function fetchFullSessionData(sessionId: string): Promise<void> {
  try {
    await Promise.all([sessionRegistry.sendSurfaceCommand(sessionId, { type: 'get_state' }), sessionRegistry.sendSurfaceCommand(sessionId, { type: 'get_messages' })]);
  } catch (error) {
    console.error('[SessionRegistry] Failed to fetch session data:', error);
  }
}

export interface AppNotificationIntent {
  sessionId: string;
  folderPath?: string;
  openDownloads?: boolean;
}

function queueDownloadNotificationIntent(intent: DownloadNotificationIntent): void {
  const folderPath = intent.folderPath ?? sessionRegistry.sessions[intent.sessionId]?.folderPath;
  if (!folderPath) return;

  // Keep the intent in the connection layer until a socket is open and all
  // existing subscriptions have been restored. This avoids adding/removing a
  // temporary session when a notification click lands during reconnect.
  connection.pendingAdopt = {
    sessionId: intent.sessionId,
    folderPath,
    openDownloads: true,
  };
  connection.connect();
}

/**
 * Route every OS notification click through one app-level adapter. Download
 * intents open only the owning session's inbox; ordinary notifications retain
 * their existing session-switch/adopt behavior.
 */
export async function routeNotificationIntent(intent: AppNotificationIntent): Promise<void> {
  if (intent.openDownloads === true) {
    const downloadIntent: DownloadNotificationIntent = {
      sessionId: intent.sessionId,
      ...(intent.folderPath ? { folderPath: intent.folderPath } : {}),
      openDownloads: true,
    };

    // A focused existing window can be in backoff or mid-restore. Queue the
    // inbox intent instead of attempting open_session over a dead socket.
    if (!connection.ready) {
      queueDownloadNotificationIntent(downloadIntent);
      return;
    }

    await handleDownloadNotificationIntent(downloadIntent, {
      hasSession: (sessionId) => sessionRegistry.isActiveSession(sessionId),
      switchToSession,
      openExistingSession: (sessionId, folderPath) => openExistingSession(sessionId, folderPath, { switchTo: true }),
      openDownloadInbox: (sessionId) => downloadUi.openDownloadInbox(sessionId),
    });

    // The socket may have dropped during the adoption request. Preserve the
    // intent for the next successful restore rather than losing the click.
    if (!connection.ready && !sessionRegistry.isActiveSession(intent.sessionId)) {
      queueDownloadNotificationIntent(downloadIntent);
    }
    return;
  }

  if (sessionRegistry.isActiveSession(intent.sessionId)) {
    switchToSession(intent.sessionId);
    return;
  }

  // The intent may carry no folder (stale payload). Every session this client
  // has opened before keeps its folder in the subscribed map — resolve through
  // it rather than silently dropping the click.
  const folderPath = intent.folderPath ?? connection.subscribedSessions.get(intent.sessionId);

  // A focused existing window can be in backoff or mid-restore. Queue the
  // adopt intent instead of attempting open_session over a dead socket.
  if (folderPath && !connection.ready) {
    connection.pendingAdopt = { sessionId: intent.sessionId, folderPath };
    connection.connect();
    return;
  }

  if (folderPath) {
    await openExistingSession(intent.sessionId, folderPath, { switchTo: true });
  }
  // No folder resolvable anywhere: stay put. An unresolvable session must not
  // bounce the view the user is already on.
}

/** Remove every client-side trace of a session before its server command settles. */
function removeSessionLocally(sessionId: string): void {
  attachedSessionIds.delete(sessionId);
  lifecycleAttachmentPromises.delete(sessionId);
  sessionRegistry.removeSession(sessionId);
  connection.removeSubscribedSession(sessionId);
  commandStore.removeSession(sessionId);
}

/** Drop every client-side trace of a session that is gone server-side
 *  (`session_not_found`) so no orphan lingers. */
function dropSession(sessionId: string): void {
  removeSessionLocally(sessionId);
}

/** Open a session by id. `folderPath` may be unknown for a deep link — the
 *  server then resolves the folder and reports it in the response. Explicit
 *  opens preserve the original request semantics and always ask the server. */
export async function openExistingSession(sessionId: string, folderPath: string | undefined, opts?: { switchTo?: boolean }): Promise<boolean> {
  const projectName = folderPath ? folderPath.split('/').pop() || 'Unknown' : 'Unknown';
  const shouldSwitch = opts?.switchTo !== false;
  const alreadyTracked = !!sessionRegistry.sessions[sessionId];
  if (!alreadyTracked) sessionRegistry.addSession(sessionId, folderPath ?? '', projectName);
  connection.addSubscribedSession(sessionId, folderPath ?? '');
  if (shouldSwitch) sessionRegistry.switchTo(sessionId);

  try {
    const response = await connection.send({ type: 'open_session', folderPath, sessionId });
    if (!response.success) {
      if (response.error === 'session_archived') {
        connection.removeSubscribedSession(sessionId);
        if (alreadyTracked) sessionRegistry.setRestorable(sessionId, false);
        else dropSession(sessionId);
        return false;
      }
      if (isSessionNotFoundError(response.error)) {
        dropSession(sessionId);
        return false;
      }
      // A transient failure must not wipe a pre-existing tab. Only tear down
      // state that this attachment created.
      if (!alreadyTracked) dropSession(sessionId);
      return false;
    }

    sessionRegistry.setRestorable(sessionId, true);
    const data = response.data as OpenSessionResponseData | undefined;
    const resolvedFolder = data?.folderPath ?? folderPath;
    if (resolvedFolder) {
      sessionRegistry.setSessionFolder(sessionId, resolvedFolder);
      connection.addSubscribedSession(sessionId, resolvedFolder);
    }
    if (data?.folder) sessionRegistry.bindSessionFolder(sessionId, data.folder);
    if (data) applyOpenSessionData(sessionId, data);
    cancelledNewSessionIds.delete(sessionId);
    if (shouldSwitch) sessionRegistry.selectSession(sessionId);
    attachedSessionIds.add(sessionId);
    return true;
  } catch (err) {
    console.error('[SessionRegistry] Failed to open existing session:', err);
    if (!alreadyTracked) dropSession(sessionId);
    return false;
  }
}

/** Attach one lifecycle push in the background. Attachments dedupe by real
 * session ID; explicit opens do not use this cache. */
function attachOpenedSessionInBackground(sessionId: string, folderPath: string): void {
  if (attachedSessionIds.has(sessionId) || lifecycleAttachmentPromises.has(sessionId)) return;
  const opening = openExistingSession(sessionId, folderPath, { switchTo: false });
  lifecycleAttachmentPromises.set(sessionId, opening);
  void opening.then(
    (attached) => {
      if (lifecycleAttachmentPromises.get(sessionId) !== opening) return;
      lifecycleAttachmentPromises.delete(sessionId);
      if (attached) attachedSessionIds.add(sessionId);
    },
    () => {
      if (lifecycleAttachmentPromises.get(sessionId) === opening) lifecycleAttachmentPromises.delete(sessionId);
    },
  );
}

/** Attach a lifecycle push in the background. It never changes the viewed
 *  session and never reconciles an optimistic placeholder. */
function attachOpenedSession(event: SessionOpenedEvent): void {
  const sessionId = event.sessionId;
  if (sessionId.startsWith('pending-') || cancelledNewSessionIds.has(sessionId)) return;
  const folder = event.folder;
  const folderPath = folder?.path ?? '';
  const existing = sessionRegistry.sessions[sessionId];
  if (!existing) {
    sessionRegistry.addSession(sessionId, folderPath, folder?.name ?? 'Unknown');
  } else if (folderPath && existing.folderPath !== folderPath) {
    sessionRegistry.setSessionFolder(sessionId, folderPath);
  }
  if (folder) sessionRegistry.bindSessionFolder(sessionId, folder);
  connection.addSubscribedSession(sessionId, folderPath);
  attachOpenedSessionInBackground(sessionId, folderPath);
}

/** Remove a failed optimistic placeholder without changing a deliberate view.
 * When the placeholder still owns the view, restore the view captured before
 * this request. Missing history intentionally falls back to the dashboard. */
function cleanupFailedNewSession(placeholderId: string, request: PendingNewSessionRequest): void {
  const placeholderWasViewed = sessionRegistry.viewedSessionId === placeholderId;
  if (sessionRegistry.sessions[placeholderId]) sessionRegistry.removeSessionQuietly(placeholderId);
  if (!placeholderWasViewed || request.cancelled) return;

  const previousId = request.previousViewedSessionId;
  if (previousId !== null && sessionRegistry.sessions[previousId]) {
    sessionRegistry.switchTo(previousId, { replace: true });
  } else {
    sessionRegistry.goHome({ replace: true });
  }
}

async function reconcileNewSessionResponse(tempId: string, response: PimoteResponse): Promise<PimoteResponse> {
  const request = pendingNewSessionRequests.get(tempId);
  if (!request) return response;
  pendingNewSessionRequests.delete(tempId);
  const placeholder = sessionRegistry.sessions[tempId];

  if (!response.success) {
    cleanupFailedNewSession(tempId, request);
    return response;
  }

  const data = response.data as (OpenSessionResponseData & { sessionId?: string; folder?: FolderInfo }) | undefined;
  const realId = data?.sessionId;
  if (!realId) {
    cleanupFailedNewSession(tempId, request);
    return response;
  }

  // A closed placeholder owns this request. The server can still finish the
  // open, so close the real session after the response instead of sending a
  // meaningless close_session for pending-*.
  if (request.cancelled) {
    cancelledNewSessionIds.add(realId);
    if (sessionRegistry.sessions[realId]) removeSessionLocally(realId);
    if (placeholder) sessionRegistry.removeSessionQuietly(tempId);
    connection.send({ type: 'close_session', sessionId: realId }).catch(() => {});
    return { ...response, success: false, error: 'session_open_cancelled' };
  }

  const folderPath = data?.folderPath ?? data?.folder?.path ?? request.folderPath;
  const folder = data?.folder;
  const projectName = folder?.name ?? folderPath.split('/').pop() ?? 'Unknown';
  const realState = sessionRegistry.sessions[realId];
  if (!realState) sessionRegistry.addSession(realId, folderPath, projectName);
  if (folderPath) sessionRegistry.setSessionFolder(realId, folderPath);
  if (folder) sessionRegistry.bindSessionFolder(realId, folder);
  connection.addSubscribedSession(realId, folderPath);
  if (data) applyOpenSessionData(realId, data);

  // A lifecycle push can create and attach this real session before the
  // command response. New-session opens carry their empty snapshot in the
  // response; existing lifecycle attachments keep their already replayed data.
  const lifecycleAttachment = lifecycleAttachmentPromises.get(realId);
  const fetchInitialSnapshot = () => {
    if (attachedSessionIds.has(realId) || !sessionRegistry.sessions[realId]) return;
    attachedSessionIds.add(realId);
    void fetchFullSessionData(realId);
  };
  if (data?.initialSnapshot) {
    sessionRegistry.handleEvent(data.initialSnapshot);
    attachedSessionIds.add(realId);
  } else if (lifecycleAttachment) {
    void lifecycleAttachment.then((attached) => {
      if (!attached) fetchInitialSnapshot();
    });
  } else {
    fetchInitialSnapshot();
  }

  const placeholderWasViewed = sessionRegistry.viewedSessionId === tempId;
  if (placeholder) sessionRegistry.removeSessionQuietly(tempId);
  if (placeholderWasViewed) {
    sessionRegistry.switchTo(realId);
    sessionRegistry.selectSession(realId);
  }
  return response;
}

/** Start a new session and return the server response. Each call owns one
 * placeholder and one continuation, so parallel opens can resolve in any order. */
export async function openNewSession(folderPath: string): Promise<PimoteResponse> {
  const placeholderId = `pending-${crypto.randomUUID()}`;
  const projectName = folderPath.split('/').pop() || 'Unknown';
  const previousViewedSessionId = sessionRegistry.viewedSessionId;
  sessionRegistry.addSession(placeholderId, folderPath, projectName);
  sessionRegistry.switchTo(placeholderId);
  const request: PendingNewSessionRequest = {
    folderPath,
    previousViewedSessionId,
    cancelled: false,
  };
  pendingNewSessionRequests.set(placeholderId, request);

  try {
    const response = await connection.send({ type: 'open_session', folderPath });
    return await reconcileNewSessionResponse(placeholderId, response);
  } catch (error) {
    const current = pendingNewSessionRequests.get(placeholderId);
    if (current) {
      pendingNewSessionRequests.delete(placeholderId);
      cleanupFailedNewSession(placeholderId, current);
    }
    return {
      id: '',
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Cancel one optimistic open. The wire request cannot be withdrawn, but its
 *  continuation will close the real session if the server later succeeds. */
function cancelNewSession(placeholderId: string): boolean {
  const request = pendingNewSessionRequests.get(placeholderId);
  if (!request) return false;
  request.cancelled = true;
  if (sessionRegistry.sessions[placeholderId]) sessionRegistry.removeSession(placeholderId);
  connection.removeSubscribedSession(placeholderId);
  commandStore.removeSession(placeholderId);
  return true;
}

// A socket drop invalidates lifecycle attachment state. Reconnect restore
// commands rebuild server ownership; a later push must not trust stale cache.
connection.onDisconnect(() => {
  attachedSessionIds.clear();
  lifecycleAttachmentPromises.clear();
  cancelledNewSessionIds.clear();
});

// Subscribe to connection events and route to the registry
connection.onEvent((event) => {
  switch (event.type) {
    case 'session_opened': {
      attachOpenedSession(event as SessionOpenedEvent);
      break;
    }
    case 'session_closed': {
      removeSessionLocally(event.sessionId);
      // The ordered close push is authoritative. A later legitimate session
      // with this identity can now attach normally.
      cancelledNewSessionIds.delete(event.sessionId);
      break;
    }
    case 'session_replaced': {
      const replaced = event as SessionReplacedEvent;
      const folder = replaced.folder;
      const projectName = folder?.name ?? 'Unknown';
      sessionRegistry.replaceSession(replaced.oldSessionId, replaced.newSessionId, folder?.path ?? '', projectName);
      if (folder) sessionRegistry.bindSessionFolder(replaced.newSessionId, folder);
      applyOpenSessionData(replaced.newSessionId, {
        ...(replaced.meta ? { meta: replaced.meta } : {}),
        ...(replaced.commands ? { commands: replaced.commands } : {}),
      });
      connection.removeSubscribedSession(replaced.oldSessionId);
      connection.addSubscribedSession(replaced.newSessionId, folder?.path ?? '');
      commandStore.removeSession(replaced.oldSessionId);
      fetchFullSessionData(replaced.newSessionId);
      break;
    }
    case 'session_commands_changed': {
      const commands = event as SessionCommandsChangedEvent;
      commandStore.setCommands(commands.sessionId, commands.commands);
      break;
    }
    default: {
      // Route all other events with sessionId to the registry
      if ('sessionId' in event) {
        sessionRegistry.handleEvent(event);
      }
      break;
    }
  }
});

// When a restore/open succeeds during the reconnect sync, rebind the session's
// folder row from the response. Restores (live reclaim, disk reopen) emit no
// session_opened event, so without this a restarted client keeps the hydrated
// folder-less state and the session chip falls back to the code-nature glyph.
connection.onSessionRestored = (sessionId, data) => {
  if (!sessionRegistry.sessions[sessionId]) {
    if (!connection.subscribedSessions.has(sessionId)) return;
    const folderPath = data.folderPath ?? connection.subscribedSessions.get(sessionId) ?? '';
    sessionRegistry.addSession(sessionId, folderPath, folderPath.split('/').pop() || 'Unknown');
  }
  if (data.folderPath) sessionRegistry.setSessionFolder(sessionId, data.folderPath);
  if (data.folder) sessionRegistry.bindSessionFolder(sessionId, data.folder);
  applyOpenSessionData(sessionId, data);
  attachedSessionIds.add(sessionId);
};

// When restoring/opening is rejected because the session is gone server-side
// (never persisted, pruned idle slot), delete the orphan locally. This fires
// from the reconnect restore loop where no `openExistingSession` call frame
// owns the cleanup.
connection.onSessionNotFound = (sessionId) => {
  dropSession(sessionId);
};

// A non-definitive reconnect failure still leaves this client without a valid
// observer. No client-side detach is sent: cleanup rests on the server's
// same-id takeover eviction (DR-067), which detaches the tab's dead socket's
// observers. This callback removes only the local session entry.
connection.onSessionRestoreFailed = (sessionId) => {
  dropSession(sessionId);
};

// The user's server profile no longer holds this session (another connection
// detached or closed it, or a stale local stray lost the reconcile). Remove
// it locally the same way a definitive not-found does.
connection.onSessionDropped = (sessionId) => {
  dropSession(sessionId);
};

// The reconcile adopted a profile session this tab never tracked. Create the
// registry entry BEFORE the open goes out: the server replays session state
// (full_resync) before the open_session response, and handleEvent drops
// events for sessions the registry does not track — a late entry would
// render the session empty forever.
connection.onReconcileAdopt = (sessionId, folderPath) => {
  if (sessionRegistry.sessions[sessionId]) return;
  sessionRegistry.addSession(sessionId, folderPath, folderPath.split('/').pop() || 'Unknown');
};

connection.onSessionArchived = (sessionId) => {
  sessionRegistry.setRestorable(sessionId, false);
};

// Order and selection ride one event: apply both, then let the selection move
// this connection's view. The connect burst's event decides the landing
// session, so a reconnect lands where the user last was (D8).
connection.onUserSessionFacts = (facts) => {
  sessionRegistry.applyUserSessionFacts(facts);
};

connection.onUserViews = (views) => {
  sessionRegistry.applyUserViews(views);
};

connection.onPendingAdopt = (sessionId, folderPath, { openDownloads }) => {
  void routeNotificationIntent({
    sessionId,
    folderPath,
    ...(openDownloads ? { openDownloads: true } : {}),
  });
};

// After restore completes, refresh per-session supplemental data and restore
// the correct viewed session on the server.
connection.onReconnected = () => {
  for (const session of sessionRegistry.activeSessions) {
    if (session.sessionId.startsWith('pending-')) continue;
    // A bash response can be accepted by the server just before the socket
    // drops. Incremental replay intentionally excludes the live delta stream,
    // so reconcile pending executions from the durable session snapshot before
    // allowing the user to submit another command. Never re-dispatch the text.
    if (sessionRegistry.hasPendingBash(session.sessionId)) {
      void fetchFullSessionData(session.sessionId);
    }
  }
  const viewedId = sessionRegistry.viewedSessionId;
  if (viewedId && !viewedId.startsWith('pending-')) {
    sessionRegistry.selectSession(viewedId);
  }
  sessionRegistry.restoreUserViews();
};

// Hydrate persisted sessions before first connection
const persistedSessions = getActiveSessions();
for (const { sessionId, folderPath } of persistedSessions) {
  const projectName = folderPath.split('/').pop() || 'Unknown';
  sessionRegistry.addSession(sessionId, folderPath, projectName);
  connection.addSubscribedSession(sessionId, folderPath);
}

// Helper that also makes the session the user's selection
export function switchToSession(sessionId: string): void {
  sessionRegistry.switchTo(sessionId);
  sessionRegistry.selectSession(sessionId);
}

/** Abort a session and recover the queues acknowledged by the server into its draft. */
export async function abortSession(sessionId: string): Promise<void> {
  if (!sessionRegistry.getSessionState(sessionId)) return;
  try {
    const response = await sessionRegistry.sendSurfaceCommand(sessionId, { type: 'abort' });
    if (!response.success) console.error('[SessionRegistry] Failed to abort session:', response.error ?? 'unknown error');
  } catch (error) {
    console.error('[SessionRegistry] Failed to send abort:', error);
  }
}

/** Remove a session from the client before its server command settles. */
export function removeSessionOptimistically(sessionId: string): boolean {
  if (!sessionRegistry.sessions[sessionId]) return false;
  if (cancelNewSession(sessionId)) return true;
  removeSessionLocally(sessionId);
  return true;
}

/** Close a session optimistically, then let the server finish the close. */
export function closeSession(sessionId: string): void {
  if (!removeSessionOptimistically(sessionId)) return;
  // cancelNewSession handled its own continuation and must never detach the
  // temporary placeholder id.
  if (pendingNewSessionRequests.has(sessionId)) return;
  connection.send({ type: 'detach_session', sessionId }).catch(() => {});
}

/** Open a new session in the same project as the given session. */
export function newSessionInProject(sessionId: string): Promise<PimoteResponse | undefined> {
  const session = sessionRegistry.sessions[sessionId];
  if (!session) return Promise.resolve(undefined);
  return openNewSession(session.folderPath);
}

/** In-flight replacement per session: a fast double-fire (double-tap on the
 *  control, /new while a placeholder open is unresolved) reuses the running
 *  replacement instead of creating a second fresh session. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- replacement deduplication bookkeeping, not reactive UI state
const inFlightReplacements = new Map<string, Promise<PimoteResponse | undefined>>();

/** Start a fresh session in this folder and drop the old one from the user's
 *  open-session list everywhere: open (attach, view, profile link), then a
 *  user-level detach of the old id. pi's /new, composed client-side — the
 *  text never dispatches to pi. Returns the running replacement on re-entry. */
export async function replaceSessionWithFresh(sessionId: string): Promise<PimoteResponse | undefined> {
  const running = inFlightReplacements.get(sessionId);
  if (running) return running;
  const replacement = (async () => {
    const session = sessionRegistry.sessions[sessionId];
    if (!session) return undefined;
    const response = await openNewSession(session.folderPath);
    // Only a successful open may unlink the old id: on failure the user stays
    // in it, and a cancelled open already tore the fresh session down.
    if (response.success) closeSession(sessionId);
    return response;
  })();
  inFlightReplacements.set(sessionId, replacement);
  try {
    return await replacement;
  } finally {
    inFlightReplacements.delete(sessionId);
  }
}
