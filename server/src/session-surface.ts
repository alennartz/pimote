import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { createHash } from 'node:crypto';
import type {
  AutocompleteResponseItem,
  CommandInfo,
  PimoteAgentMessage,
  PimoteSessionEvent,
  PimoteTreeNode,
  SessionMeta,
  SessionState,
  StreamingMessage,
} from '../../shared/dist/index.js';
import type { AgentPath, BorrowedAgentSession, SubagentPresentationProvider, SubagentProviderEvent } from '@pimote/sdk/subagents';
import { EventBuffer, type IncomingSdkEvent } from './event-buffer.js';
import { mapAgentMessage, mapContextEntries, type SdkSessionEntry } from './message-mapper.js';
import { resolveImageInputs } from './image-registry.js';
import { completeFileRefs } from './file-references.js';
import { projectSessionUsage } from './session-usage.js';
import { attributeDrained, type QueueOwnership } from './queue-ownership.js';
import { mapTreeNodes, type SessionTreeNode } from './session-tree.js';
import { createSubagentTranscriptProjector, type SubagentProjectionSnapshot, type SubagentTranscriptProjector } from './subagent-transcript-projector.js';

/** Commands allowed through both root and child session surfaces. */
export type SessionSurfaceCommand =
  | { type: 'prompt'; id?: string; message: string; images?: string[]; streamingBehavior?: 'streaming' | 'blocking'; clientMessageId?: string }
  | { type: 'steer'; id?: string; message: string; images?: string[] }
  | { type: 'follow_up'; id?: string; message: string }
  | { type: 'abort'; id?: string }
  | { type: 'bash'; id?: string; command: string; excludeFromContext?: boolean }
  | { type: 'abort_bash'; id?: string }
  | { type: 'set_model'; id?: string; provider: string; modelId: string }
  | { type: 'cycle_model'; id?: string }
  | { type: 'get_available_models'; id?: string }
  | { type: 'set_thinking_level'; id?: string; level: string }
  | { type: 'cycle_thinking_level'; id?: string }
  | { type: 'compact'; id?: string; customInstructions?: string }
  | { type: 'set_auto_compaction'; id?: string; enabled: boolean }
  | { type: 'get_state'; id?: string }
  | { type: 'get_messages'; id?: string }
  | { type: 'get_session_stats'; id?: string }
  | { type: 'get_session_meta'; id?: string }
  | { type: 'get_commands'; id?: string }
  | { type: 'complete_args'; id?: string; commandName: string; prefix: string }
  | { type: 'complete_file_refs'; id?: string; prefix: string }
  | { type: 'get_tree'; id?: string }
  | {
      type: 'navigate_tree';
      id?: string;
      targetId: string;
      summarize?: boolean;
      customInstructions?: string;
      replaceInstructions?: boolean;
      label?: string;
    }
  | { type: 'set_tree_label'; id?: string; entryId: string; label?: string }
  | { type: 'set_session_name'; id?: string; name: string };

/** Full transcript/state snapshot at this surface's own event cursor. */
export interface SessionSurfaceSnapshot {
  cursor: number;
  state: SessionState;
  messages: PimoteAgentMessage[];
  pendingSteeringMessages?: readonly string[];
  activeSubagentContent?: readonly import('../../shared/dist/index.js').PimoteActiveSubagentContent[];
  branchEntryIds?: readonly string[];
  streamingMessage?: StreamingMessage;
  runningToolCallIds?: string[];
}

export type SessionSurfaceReplay =
  | { kind: 'events'; cursor: number; events: readonly PimoteSessionEvent[] }
  | { kind: 'snapshot_required'; reason: 'cursor_invalid' | 'history_unavailable' };

/** Result returned when an observer attaches to a surface. */
export interface SessionSurfaceAttachment {
  observerId: string;
  cursor: number;
  snapshot?: SessionSurfaceSnapshot;
  events?: readonly PimoteSessionEvent[];
  release(): void;
}

export type SessionSurfaceKind = 'root' | 'child';

/** Caller identity used for queue attribution and prompt ownership. */
export interface SessionSurfaceCallerContext {
  clientId?: string;
  queueOwnership?: QueueOwnership;
}

/** Session-local capabilities that do not belong on the borrowed native session. */
export interface SessionSurfaceCapabilities {
  resolveModel(provider: string, modelId: string): Promise<Parameters<BorrowedAgentSession['setModel']>[0] | undefined>;
  getSettings(): { availableThinkingLevels: string[]; autoCompactionEnabled: boolean; sessionName?: string };
  getCommands(): Promise<readonly CommandInfo[]>;
  completeArgs(commandName: string, prefix: string): Promise<readonly AutocompleteResponseItem[]>;
  completeFileRefs(prefix: string): Promise<readonly AutocompleteResponseItem[]>;
  nativeBash?: {
    admitted?: boolean;
    execute?: (command: string, options: { id?: string; excludeFromContext?: boolean }) => Promise<unknown>;
    abort?: () => Promise<void> | void;
  };
  executeBash(command: string, options: { id?: string; excludeFromContext?: boolean }): Promise<unknown>;
  getGitBranch(): string | null;
  /** Provider-owned child operation projection. Omitted means legacy/full access. */
  operations?: readonly string[];
  /** Whether the child view may render custom extension entries. */
  renderer?: { visible?: boolean };
  /** Optional model catalog used by the child model picker. */
  getAvailableModels?: () => Promise<readonly unknown[]>;
}

export interface SessionSurfaceStopRequest {
  path: readonly string[];
  incarnation: string;
  expectedSessionId: string;
}

type NativeCommand = {
  name: string;
  description?: string;
  getArgumentCompletions?: (prefix: string) => Promise<readonly AutocompleteResponseItem[] | null> | readonly AutocompleteResponseItem[] | null;
};

type NativeSessionExtras = {
  modelRuntime?: { getAvailable?: () => Promise<readonly unknown[]> | readonly unknown[] };
  getAvailableThinkingLevels?: () => readonly string[];
  autoCompactionEnabled?: boolean;
  sessionName?: string;
  clearQueue?: () => { steering: string[]; followUp: string[] };
  extensionRunner?: {
    getEntryRenderer?: (customType: string) => unknown;
    getRegisteredCommands?: () => readonly NativeCommand[];
    getCommand?: (name: string) => NativeCommand | undefined;
  };
  resourceLoader?: { getSkills?: () => { skills?: readonly { name: string; description?: string }[] } };
  promptTemplates?: readonly { name: string; description?: string }[];
};

type NativeSessionManagerExtras = {
  getBranch?: () => unknown;
  getEntries?: () => unknown;
  buildContextEntries?: () => unknown;
  getCwd?: () => string;
  getTree?: () => unknown;
  getLeafId?: () => unknown;
  appendLabelChange?: (entryId: string, label?: string) => void;
};

export interface SessionSurfaceOptions {
  sessionId: string;
  session: BorrowedAgentSession;
  kind: SessionSurfaceKind;
  capabilities?: SessionSurfaceCapabilities;
  /** Root-only lifecycle adapters that preserve slot-level queue and bash semantics. */
  rootAbort?: (caller?: SessionSurfaceCallerContext) => Promise<unknown>;
  rootBash?: (command: Extract<SessionSurfaceCommand, { type: 'bash' }>, caller?: SessionSurfaceCallerContext) => Promise<unknown>;
  rootAbortBash?: (caller?: SessionSurfaceCallerContext) => Promise<void>;
  /** Parent replay cursor, when this surface is a child view. It is diagnostic only. */
  parentCursor?: number;
  /** Share an existing event buffer with a root session slot. */
  eventBuffer?: EventBuffer;
  /** Root surfaces receive native events from the slot state mapper. */
  subscribeNative?: boolean;
  /** Provider owner-control stop seam for child views. */
  stop?: (request: SessionSurfaceStopRequest) => Promise<void>;
  /** Public child path and incarnation used by guarded Stop. */
  path?: readonly string[];
  incarnation?: string;
  /** Cached branch projection for root session metadata. */
  getGitBranch?: () => string | null;
  /** Buffer capacity for this independent surface. */
  bufferCapacity?: number;
  /** Optional semantic provider hydrated before the first client snapshot. */
  subagentProvider?: Pick<SubagentPresentationProvider, 'rehydrate' | 'snapshot' | 'subscribe' | 'replay'>;
  /** Logical path supplied to provider hydration. */
  subagentPath?: AgentPath;
  /** Prior projected state retained when a child view is rebuilt. */
  initialProjection?: SubagentProjectionSnapshot;
}

/** Caller-aware dispatch overload. */
export interface SessionSurface {
  readonly sessionId: string;
  readonly kind: SessionSurfaceKind;
  readonly currentCursor: number;
  /** Subscribe to native Pi events before taking the first transcript snapshot. */
  initialize(): Promise<SessionSurfaceSnapshot>;
  /** Accept one native Pi event when the owning slot supplies the subscription. */
  acceptNativeEvent(event: IncomingSdkEvent): void;
  /** Accept a provider operation routed to this session surface. */
  acceptProviderEvent?(event: SubagentProviderEvent): void;
  /** Read the current projected state without invalidating replay. */
  snapshot(): SessionSurfaceSnapshot;
  /** Attach or replace the provider after root discovery. */
  setSubagentProvider?(provider: Pick<SubagentPresentationProvider, 'rehydrate' | 'snapshot' | 'subscribe' | 'replay'>): Promise<void>;
  /** Rebuild the transcript/state snapshot and invalidate prior replay positions. */
  refreshSnapshot(): SessionSurfaceSnapshot;
  subscribe(listener: (event: PimoteSessionEvent) => void): () => void;
  /** Stop observing the native session without disposing it. */
  close(): void;
  attachObserver(observerId: string, after?: number): Promise<SessionSurfaceAttachment>;
  replay(after?: number): SessionSurfaceReplay;
  dispatch(command: SessionSurfaceCommand, caller?: SessionSurfaceCallerContext): Promise<unknown>;
  /** Full state/meta reads remain surface-local and do not move parent cursors. */
  getState(): Promise<SessionState>;
  getMeta(): Promise<SessionMeta>;
  getMessages(): Promise<readonly PimoteAgentMessage[]>;
  getCommands(): Promise<readonly CommandInfo[]>;
  completeArgs(commandName: string, prefix: string): Promise<readonly AutocompleteResponseItem[]>;
  completeFileRefs(prefix: string): Promise<readonly AutocompleteResponseItem[]>;
}

const SURFACE_BUFFER_CAPACITY = 2048;
const SAFE_CHILD_COMMANDS = new Set(['tree', 'compact']);
const ROOT_LIFECYCLE_COMMANDS = new Set([
  'new_session',
  'open_session',
  'resume',
  'switch_session',
  'fork',
  'reload',
  'archive_session',
  'delete_session',
  'set_profile',
  'call_bind',
  'call_end',
  'teardown',
  'new',
  'switch',
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function commandToken(message: string): string | undefined {
  const token = message.trim().split(/\s+/, 1)[0];
  if (!token.startsWith('/')) return undefined;
  return token.slice(1).toLowerCase();
}

function isAgentMessage(value: unknown): value is AgentMessage {
  return !!value && typeof value === 'object' && typeof (value as { role?: unknown }).role === 'string';
}

function mapModel(model: unknown): SessionState['model'] {
  const candidate = asRecord(model);
  if (typeof candidate.provider !== 'string' || typeof candidate.id !== 'string') return null;
  return {
    provider: candidate.provider,
    id: candidate.id,
    name: typeof candidate.name === 'string' ? candidate.name : candidate.id,
  };
}

function mapStreamingMessage(value: unknown): StreamingMessage | undefined {
  if (!isAgentMessage(value)) return undefined;
  const mapped = mapAgentMessage(value);
  return {
    role: mapped.role,
    content: mapped.content,
    ...(mapped.usage ? { usage: mapped.usage } : {}),
    ...(mapped.customType ? { customType: mapped.customType } : {}),
    ...(mapped.details !== undefined ? { details: mapped.details } : {}),
    ...(mapped.display !== undefined ? { display: mapped.display } : {}),
  };
}

function hasMessageContent(message: AgentMessage): boolean {
  if (!('content' in message)) return false;
  if (typeof message.content === 'string') return message.content.length > 0;
  return Array.isArray(message.content) && message.content.length > 0;
}

/**
 * Some providers emit an empty message_end while the completed message is
 * already present in the native session. Resolve that tail before semantic
 * projection so hidden blocks are sanitized by the projector, not by the
 * untrusted event-buffer fallback.
 */
function messageEndForProjection(event: IncomingSdkEvent, session: BorrowedAgentSession): IncomingSdkEvent {
  if (event.type !== 'message_end' || hasMessageContent(event.message)) return event;
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const fallback = messages[messages.length - 1];
  if (!isAgentMessage(fallback) || fallback.role !== event.message.role) return event;
  return { ...event, message: fallback };
}

function isSubagentContentBlock(block: import('../../shared/dist/index.js').PimoteMessageContent): boolean {
  return block.type === 'subagent';
}

interface SnapshotMessageIndex {
  readonly entryIds: ReadonlySet<string>;
  readonly contentFingerprints: ReadonlySet<string>;
}

const snapshotMessageIndexes = new WeakMap<SessionSurfaceSnapshot, SnapshotMessageIndex>();

function messageContentFingerprint(message: PimoteAgentMessage): string {
  return `${message.role}:${createHash('sha256').update(JSON.stringify(message.content)).digest('hex')}`;
}

function indexSnapshotMessages(snapshot: SessionSurfaceSnapshot): SnapshotMessageIndex {
  let index = snapshotMessageIndexes.get(snapshot);
  if (index) return index;
  const entryIds = new Set<string>();
  const contentFingerprints = new Set<string>();
  for (const message of snapshot.messages) {
    if (message.entryId) entryIds.add(message.entryId);
    contentFingerprints.add(messageContentFingerprint(message));
  }
  index = { entryIds, contentFingerprints };
  snapshotMessageIndexes.set(snapshot, index);
  return index;
}

/** A persisted final message already present in a snapshot needs no second
 * delivery from the listener that observed it at the snapshot boundary. */
function messageIsInSnapshot(event: PimoteSessionEvent, snapshot: SessionSurfaceSnapshot): boolean {
  if (event.type === 'subagent_content_start' || event.type === 'subagent_content_delta' || event.type === 'subagent_content_end') {
    return (
      snapshot.messages.some((message) => message.content.some((content) => content.type === 'subagent' && content.operationId === event.operationId)) ||
      snapshot.streamingMessage?.content.some((content) => content.type === 'subagent' && content.operationId === event.operationId) === true
    );
  }
  if (event.type !== 'message_end' || event.clientMessageId !== undefined) return false;
  const index = indexSnapshotMessages(snapshot);
  if (event.message.entryId !== undefined && index.entryIds.has(event.message.entryId)) return true;
  return index.contentFingerprints.has(messageContentFingerprint(event.message));
}

/** Map a saved branch without applying compaction's context projection. */
function mapSavedBranch(entries: readonly SdkSessionEntry[], customVisible: (customType: string) => boolean): PimoteAgentMessage[] {
  let seenLeadingSystem = false;
  const output: PimoteAgentMessage[] = [];
  for (const entry of entries) {
    const record = entry as unknown as Record<string, unknown>;
    if (record.type === 'message' && isAgentMessage(record.message)) {
      const message = record.message as AgentMessage;
      if (message.role === 'system' && !seenLeadingSystem) {
        seenLeadingSystem = true;
        continue;
      }
      output.push({ ...mapAgentMessage(message), entryId: typeof record.id === 'string' ? record.id : undefined });
      continue;
    }
    if (record.type === 'custom' && typeof record.customType === 'string' && !customVisible(record.customType)) continue;
    // Mapping one entry at a time keeps compaction and branch summaries while
    // avoiding mapContextEntries' deliberate omission of history before a compaction.
    const mapped = mapContextEntries([entry], customVisible);
    for (const message of mapped) {
      output.push({ ...message, entryId: message.entryId ?? (typeof record.id === 'string' ? record.id : undefined) });
    }
  }
  return output;
}

function defaultCapabilities(session: BorrowedAgentSession, getGitBranch?: () => string | null): SessionSurfaceCapabilities {
  const native = session as BorrowedAgentSession & NativeSessionExtras;
  return {
    resolveModel: async (provider, modelId) => {
      const models = (await native.modelRuntime?.getAvailable?.()) as unknown[] | undefined;
      return (models ?? []).find((model) => {
        const candidate = asRecord(model);
        return candidate.provider === provider && candidate.id === modelId;
      }) as Parameters<BorrowedAgentSession['setModel']>[0] | undefined;
    },
    getSettings: () => ({
      availableThinkingLevels: typeof native.getAvailableThinkingLevels === 'function' ? [...native.getAvailableThinkingLevels()] : [],
      autoCompactionEnabled: Boolean(native.autoCompactionEnabled),
      ...(typeof native.sessionName === 'string' ? { sessionName: native.sessionName } : {}),
    }),
    getCommands: async () => {
      const commands: CommandInfo[] = [];
      for (const skill of native.resourceLoader?.getSkills?.()?.skills ?? []) {
        commands.push({ name: `skill:${skill.name}`, description: skill.description ?? '', hasArgCompletions: false });
      }
      for (const template of native.promptTemplates ?? []) {
        commands.push({ name: template.name, description: template.description ?? '', hasArgCompletions: false });
      }
      for (const command of native.extensionRunner?.getRegisteredCommands?.() ?? []) {
        commands.push({ name: command.name, description: command.description ?? '', hasArgCompletions: typeof command.getArgumentCompletions === 'function' });
      }
      commands.push(
        { name: 'new', description: 'Start a new session', hasArgCompletions: false },
        { name: 'reload', description: 'Reload extensions and skills', hasArgCompletions: false },
        { name: 'tree', description: 'Navigate session history tree', hasArgCompletions: false },
        { name: 'login', description: 'Log in to a model provider', hasArgCompletions: false },
        { name: 'logout', description: 'Log out from a model provider', hasArgCompletions: false },
        { name: 'compact', description: 'Manually compact the session context', hasArgCompletions: false },
      );
      return commands;
    },
    completeArgs: async (commandName, prefix) => {
      const items = await native.extensionRunner?.getCommand?.(commandName)?.getArgumentCompletions?.(prefix);
      return items ?? [];
    },
    completeFileRefs: async (prefix) => {
      const manager = native.sessionManager as unknown as NativeSessionManagerExtras | undefined;
      const cwd = manager?.getCwd?.() ?? process.cwd();
      return (await completeFileRefs({ prefix, cwd })).items;
    },
    executeBash: async (command, options) => native.executeBash(command, undefined, options),
    getGitBranch: () => getGitBranch?.() ?? null,
  };
}

function getCapability(options: SessionSurfaceOptions): SessionSurfaceCapabilities {
  return options.capabilities ?? defaultCapabilities(options.session, options.getGitBranch);
}

function allowedOperation(options: SessionSurfaceOptions, capabilities: SessionSurfaceCapabilities, operation: string): boolean {
  if (options.kind === 'root' || capabilities.operations === undefined) return true;
  return capabilities.operations.includes(operation);
}

function stateFor(session: BorrowedAgentSession, capabilities: SessionSurfaceCapabilities): SessionState {
  const native = session as BorrowedAgentSession & NativeSessionExtras;
  const settings = capabilities.getSettings();
  const model = mapModel(session.model);
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const available = typeof native.getAvailableThinkingLevels === 'function' ? native.getAvailableThinkingLevels() : settings.availableThinkingLevels;
  return {
    model,
    thinkingLevel: String(session.thinkingLevel ?? ''),
    availableThinkingLevels: [...(available ?? [])],
    isStreaming: Boolean(session.isStreaming),
    isCompacting: Boolean(session.isCompacting),
    sessionFile: session.sessionFile,
    sessionId: session.sessionId,
    ...(typeof native.sessionName === 'string' ? { sessionName: native.sessionName } : settings.sessionName ? { sessionName: settings.sessionName } : {}),
    autoCompactionEnabled: Boolean(native.autoCompactionEnabled ?? settings.autoCompactionEnabled),
    messageCount: messages.length,
  };
}

function fullMessagesFor(options: SessionSurfaceOptions, capabilities: SessionSurfaceCapabilities, visible?: (customType: string) => boolean): PimoteAgentMessage[] {
  const session = options.session;
  const manager = session.sessionManager as unknown as NativeSessionManagerExtras | undefined;
  const native = session as BorrowedAgentSession & NativeSessionExtras;
  const customVisible =
    visible ??
    ((customType: string) =>
      capabilities.renderer?.visible !== false && (native.extensionRunner?.getEntryRenderer ? Boolean(native.extensionRunner.getEntryRenderer(customType)) : false));
  if (options.kind === 'child') {
    const rawEntries = manager?.getBranch?.() ?? manager?.getEntries?.();
    if (Array.isArray(rawEntries)) return mapSavedBranch(rawEntries as SdkSessionEntry[], customVisible);
  }
  const rawContextEntries = manager?.buildContextEntries?.();
  if (Array.isArray(rawContextEntries)) return mapContextEntries(rawContextEntries as SdkSessionEntry[], customVisible);
  return Array.isArray(session.messages) ? session.messages.filter(isAgentMessage).map(mapAgentMessage) : [];
}

function nativeBranchEntryIds(session: BorrowedAgentSession): string[] | undefined {
  const manager = session.sessionManager as unknown as NativeSessionManagerExtras | undefined;
  const entries = manager?.getBranch?.();
  return Array.isArray(entries) ? entries.flatMap((entry) => (typeof asRecord(entry).id === 'string' ? [asRecord(entry).id as string] : [])) : undefined;
}

function activeContentForOperation(
  operation: import('@pimote/sdk/subagents').ActiveSubagentOperation,
  messages: readonly PimoteAgentMessage[],
  sessionId: string,
): import('../../shared/dist/index.js').PimoteActiveSubagentContent {
  const placement = operation.target.placement;
  let parentMessageId = `message-${Math.max(
    0,
    messages.findIndex((message) => message.role === 'assistant'),
  )}`;
  let contentIndex = placement && 'toolCallId' in placement ? placement.contentIndex : 0;
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    const projectedIndex = message.content.findIndex((content) => content.type === 'subagent' && content.operationId === operation.target.operationId);
    if (projectedIndex < 0) continue;
    parentMessageId = message.entryId ?? `message-${messageIndex}`;
    contentIndex = projectedIndex;
    break;
  }
  if (placement && 'entryId' in placement) {
    const index = messages.findIndex((message) => message.entryId === placement.entryId);
    if (index >= 0 && !messages[index].content.some((content) => content.type === 'subagent' && content.operationId === operation.target.operationId)) {
      parentMessageId = messages[index].entryId ?? `message-${index}`;
      contentIndex = Math.min(contentIndex, messages[index].content.length);
    }
  } else if (placement && 'toolCallId' in placement) {
    const index = messages.findIndex((message) => message.content.some((content) => content.toolCallId === placement.toolCallId));
    if (index >= 0 && parentMessageId.startsWith('message-')) parentMessageId = messages[index].entryId ?? `message-${index}`;
  }
  void sessionId;
  return {
    parentMessageId,
    contentIndex,
    operationId: operation.target.operationId,
    kind: operation.target.kind,
    placement: placement ?? { entryId: parentMessageId },
    data: operation.data as unknown as import('../../shared/dist/index.js').PimoteSubagentStartData,
  };
}

function snapshotFor(
  options: SessionSurfaceOptions,
  capabilities: SessionSurfaceCapabilities,
  cursor: number,
  projector?: SubagentTranscriptProjector,
  visible?: (customType: string) => boolean,
): SessionSurfaceSnapshot {
  const session = options.session;
  const branchEntryIds = nativeBranchEntryIds(session);
  const pending = session.state?.pendingToolCalls;
  const pendingToolCallIds = pending && typeof (pending as Set<string>).values === 'function' ? [...(pending as Set<string>)] : [];
  const partial = mapStreamingMessage(session.state?.streamingMessage);
  const nativeMessages = fullMessagesFor(options, capabilities, visible);
  const projectedPartial = partial ? (projector?.projectStreamingMessage?.(partial) ?? partial) : undefined;
  const projected = projector?.snapshot();
  const projectedMessages = [...(projected?.messages ?? nativeMessages)];
  const messages = projected
    ? projectedMessages.filter(
        (message, index) =>
          !(projectedPartial && index === nativeMessages.length && message.role === 'assistant' && message.content.length > 0 && message.content.every(isSubagentContentBlock)),
      )
    : projectedMessages;
  return {
    cursor,
    state: stateFor(session, capabilities),
    messages,
    ...(options.kind === 'child' ? { pendingSteeringMessages: [...(session.getSteeringMessages?.() ?? [])] } : {}),
    ...(projected ? { activeSubagentContent: projected.activeOperations.map((operation) => activeContentForOperation(operation, projectedMessages, options.sessionId)) } : {}),
    ...(branchEntryIds !== undefined ? { branchEntryIds } : {}),
    ...(projectedPartial ? { streamingMessage: projectedPartial } : {}),
    ...(pendingToolCallIds.length > 0 ? { runningToolCallIds: pendingToolCallIds } : {}),
  };
}

function dispatchPrompt(
  session: BorrowedAgentSession,
  text: string,
  images: readonly { type: 'image'; data: string; mimeType: string }[] | undefined,
  streamingBehavior: 'steer' | 'followUp',
  onStarted: () => void,
): Promise<'started' | 'queued' | 'handled'> {
  return new Promise((resolve, reject) => {
    let dispatched = false;
    const prompt = (session.prompt as unknown as (text: string, options?: Record<string, unknown>) => Promise<void>)(text, {
      images,
      streamingBehavior,
      preflightResult: (disposition: 'started' | 'queued' | 'handled') => {
        dispatched = true;
        if (disposition === 'started') onStarted();
        resolve(disposition);
      },
    });
    Promise.resolve(prompt).then(
      () => {
        if (!dispatched) resolve('queued');
      },
      (error: unknown) => {
        if (!dispatched) reject(error);
      },
    );
  });
}

/** Construct a shared root or borrowed-child session surface. */
export function createSessionSurface(options: SessionSurfaceOptions): SessionSurface {
  const capabilities = getCapability(options);
  let subagentProvider = options.subagentProvider;
  let providerSnapshot = subagentProvider?.snapshot?.();
  const customEntryVisible = (customType: string): boolean => {
    if (providerSnapshot?.manifest?.hiddenCustomTypes.includes(customType)) return true;
    if (capabilities.renderer?.visible === false) return false;
    const runner = (options.session as unknown as { extensionRunner?: { getEntryRenderer?: (name: string) => unknown } }).extensionRunner;
    return runner?.getEntryRenderer ? Boolean(runner.getEntryRenderer(customType)) : false;
  };
  const surfacePath = options.subagentPath ?? [];
  const samePath = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && left.every((part, index) => part === right[index]);
  const providerEventBelongsToSurface = (event: SubagentProviderEvent): boolean => {
    if (!('target' in event)) return false;
    return samePath(event.target.path, surfacePath);
  };
  const activeOperationsForSurface = (operations: readonly import('@pimote/sdk/subagents').ActiveSubagentOperation[] | undefined) =>
    (operations ?? []).filter((operation) => samePath(operation.target.path, surfacePath));
  let projector: SubagentTranscriptProjector | undefined = subagentProvider
    ? createSubagentTranscriptProjector({
        sessionId: options.sessionId,
        manifest: providerSnapshot?.manifest ?? { hiddenToolNames: [], hiddenCustomTypes: [] },
        customEntryVisible,
      })
    : undefined;
  const eventBuffer =
    options.eventBuffer ??
    new EventBuffer(options.bufferCapacity ?? SURFACE_BUFFER_CAPACITY, customEntryVisible, 0, () =>
      fullMessagesFor(options, capabilities, customEntryVisible).flatMap((message) => (message.entryId ? [message.entryId] : [])),
    );
  const listensToNative = options.subscribeNative !== false;
  const listeners = new Set<(event: PimoteSessionEvent) => void>();
  const observers = new Map<string, { cursor: number; active: boolean }>();
  let nativeUnsubscribe: (() => void) | undefined;
  let providerUnsubscribe: (() => void) | undefined;
  let initialized = false;
  let initializing = false;
  let closed = false;
  let staged: PimoteSessionEvent[] = [];

  const emit = (event: PimoteSessionEvent): void => {
    for (const observer of observers.values()) {
      if (observer.active && 'cursor' in event && typeof event.cursor === 'number') observer.cursor = Math.max(observer.cursor, event.cursor);
    }
    for (const listener of [...listeners]) listener(event);
  };

  const receive = (event: PimoteSessionEvent): void => {
    if (initializing || !initialized) staged.push(event);
    else emit(event);
  };

  const appendProjected = (event: PimoteSessionEvent): void => {
    if (closed) return;
    eventBuffer.appendProjectedEvent(event, options.sessionId, receive);
  };

  const mapAndReceive = (sdkEvent: IncomingSdkEvent): void => {
    if (closed) return;
    const projectionInput = projector ? messageEndForProjection(sdkEvent, options.session) : sdkEvent;
    const projected = projector?.acceptNativeEvent(projectionInput) ?? [];
    for (const event of projected) appendProjected(event);
    if (projector?.isNativeEventSuppressed?.(projectionInput)) return;
    const projectedNativeEvent = projector?.projectNativeEvent?.(projectionInput) ?? projectionInput;
    if (!projectedNativeEvent) return;
    eventBuffer.onEvent(
      projectedNativeEvent,
      options.sessionId,
      receive,
      projector
        ? undefined
        : () => {
            const messages = options.session.messages;
            const last = messages[messages.length - 1];
            return last as AgentMessage | undefined;
          },
    );
  };

  const receiveProviderEvent = (event: SubagentProviderEvent): void => {
    if (closed || !providerEventBelongsToSurface(event)) return;
    const projected = projector?.acceptProviderEvent(event) ?? [];
    for (const item of projected) {
      if (initializing || !initialized) staged.push(item);
      else appendProjected(item);
    }
  };

  const ensureSubscription = (): void => {
    if (!listensToNative || nativeUnsubscribe || closed) return;
    nativeUnsubscribe = options.session.subscribe((event) => mapAndReceive(event));
  };

  const readMessages = (): readonly PimoteAgentMessage[] => projector?.snapshot().messages ?? fullMessagesFor(options, capabilities, customEntryVisible);

  const dispatch = async (command: SessionSurfaceCommand, caller?: SessionSurfaceCallerContext): Promise<unknown> => {
    if (closed) throw new Error('session surface is closed');
    const session = options.session;
    const native = session as BorrowedAgentSession & NativeSessionExtras;
    const type = (command as { type: string }).type;
    if (ROOT_LIFECYCLE_COMMANDS.has(type)) throw new Error(`${type} is not available on a session surface`);

    const ensure = (operation: string) => {
      if (!allowedOperation(options, capabilities, operation)) throw new Error(`${operation} is not available on this child surface`);
    };

    switch (command.type) {
      case 'prompt': {
        ensure('prompt');
        const slash = commandToken(command.message);
        if (options.kind === 'child' && slash && !SAFE_CHILD_COMMANDS.has(slash)) throw new Error(`slash command /${slash} is not available on a child surface`);
        if (options.kind === 'child' && slash === 'tree') {
          ensure('tree');
          return getTree();
        }
        if (options.kind === 'child' && slash === 'compact') {
          ensure('compact');
          return { result: await session.compact(command.message.trim().slice('/compact'.length).trim() || undefined) };
        }
        const promptIntent =
          caller?.queueOwnership && caller.clientId && session.isStreaming ? caller.queueOwnership.intend('steering', caller.clientId, command.message) : undefined;
        try {
          const images = await resolveImageInputs(command.images);
          const disposition = await dispatchPrompt(session, command.message, images, command.streamingBehavior === 'blocking' ? 'followUp' : 'steer', () => {
            if (command.clientMessageId !== undefined) eventBuffer.expectPromptEcho(command.clientMessageId);
          });
          if (promptIntent && disposition !== 'queued') caller?.queueOwnership?.cancel(promptIntent);
          return { outcome: disposition };
        } catch (error) {
          if (promptIntent) caller?.queueOwnership?.cancel(promptIntent);
          throw error;
        }
      }
      case 'steer': {
        ensure('steer');
        const slash = commandToken(command.message);
        if (options.kind === 'child' && slash) throw new Error(`slash command /${slash} is not available on a child surface`);
        const intent = caller?.queueOwnership && caller.clientId ? caller.queueOwnership.intend('steering', caller.clientId, command.message) : undefined;
        try {
          const images = await resolveImageInputs(command.images);
          const result = await dispatchPrompt(session, command.message, images, 'steer', () => undefined);
          if (intent && result !== 'queued') caller?.queueOwnership?.cancel(intent);
          return { outcome: result };
        } catch (error) {
          if (intent) caller?.queueOwnership?.cancel(intent);
          throw error;
        }
      }
      case 'follow_up': {
        ensure('follow_up');
        const slash = commandToken(command.message);
        if (options.kind === 'child' && slash) throw new Error(`slash command /${slash} is not available on a child surface`);
        if (options.kind === 'root') {
          const intent = caller?.queueOwnership && caller.clientId ? caller.queueOwnership.intend('followUp', caller.clientId, command.message) : undefined;
          try {
            const result = await dispatchPrompt(session, command.message, undefined, 'followUp', () => undefined);
            if (intent && result !== 'queued') caller?.queueOwnership?.cancel(intent);
            return { outcome: result };
          } catch (error) {
            if (intent) caller?.queueOwnership?.cancel(intent);
            throw error;
          }
        }
        const intent = caller?.queueOwnership && caller.clientId ? caller.queueOwnership.intend('followUp', caller.clientId, command.message) : undefined;
        try {
          const result = await (session.followUp as unknown as (text: string) => Promise<'queued' | 'handled'>)(command.message);
          if (intent && result !== 'queued') caller?.queueOwnership?.cancel(intent);
          return { outcome: result };
        } catch (error) {
          if (intent) caller?.queueOwnership?.cancel(intent);
          throw error;
        }
      }
      case 'abort': {
        ensure('stop');
        if (options.kind === 'root' && options.rootAbort) return options.rootAbort(caller);
        if (options.kind === 'child') {
          if (!options.stop) throw new Error('child Stop is not available without owner control');
          await options.stop({ path: options.path ?? [], incarnation: options.incarnation ?? '', expectedSessionId: session.sessionId });
          // Older surface callers supplied a no-op stop hook while the owner
          // control port was introduced. Keep that fixture-compatible path
          // only when no guarded identity was supplied. Production child
          // views always carry path + incarnation and never call abort here.
          if (options.path === undefined && options.incarnation === undefined && session.isStreaming) await session.abort();
          return { steering: [], followUp: [] };
        }
        const owners = caller?.queueOwnership?.snapshot();
        const drained = typeof native.clearQueue === 'function' ? native.clearQueue() : { steering: [], followUp: [] };
        const drafts = owners && caller?.clientId ? attributeDrained(owners, drained, caller.clientId) : new Map();
        await session.abort();
        return drafts.get(caller?.clientId ?? '') ?? { steering: [], followUp: [] };
      }
      case 'bash': {
        ensure('bash');
        if (options.kind === 'root' && options.rootBash) return { result: await options.rootBash(command, caller) };
        if (options.kind === 'child' && capabilities.nativeBash?.admitted === false) throw new Error('native bash is not available on this child surface');
        const bash = options.kind === 'child' && capabilities.nativeBash?.execute ? capabilities.nativeBash.execute : capabilities.executeBash;
        if (!bash) throw new Error('native bash is not available');
        const result = await bash(command.command, { id: command.id, excludeFromContext: command.excludeFromContext });
        return { result };
      }
      case 'abort_bash': {
        ensure('abort_bash');
        if (options.kind === 'root' && options.rootAbortBash) {
          await options.rootAbortBash(caller);
          return undefined;
        }
        const abortBash = options.kind === 'child' && capabilities.nativeBash?.abort ? capabilities.nativeBash.abort : session.abortBash;
        if (!abortBash) throw new Error('native bash is not available');
        await abortBash.call(options.kind === 'child' && capabilities.nativeBash?.abort ? capabilities.nativeBash : session);
        return undefined;
      }
      case 'set_model': {
        ensure('set_model');
        const model = await capabilities.resolveModel(command.provider, command.modelId);
        if (!model) throw new Error(`Model not found: ${command.provider}/${command.modelId}`);
        await session.setModel(model);
        return { model: mapModel(session.model), thinkingLevel: session.thinkingLevel, availableThinkingLevels: getAvailableThinkingLevels(session, capabilities) };
      }
      case 'cycle_model': {
        ensure('cycle_model');
        const result = await session.cycleModel();
        return result ? { model: mapModel(result.model), thinkingLevel: result.thinkingLevel, isScoped: result.isScoped } : null;
      }
      case 'get_available_models': {
        ensure('state');
        if (capabilities.getAvailableModels) return { models: await capabilities.getAvailableModels() };
        const models = await (native.modelRuntime?.getAvailable?.() ?? []);
        return { models: (models as unknown[]).map(mapModel).filter((model): model is NonNullable<typeof model> => model !== null) };
      }
      case 'set_thinking_level': {
        ensure('set_thinking_level');
        session.setThinkingLevel(command.level as Parameters<BorrowedAgentSession['setThinkingLevel']>[0]);
        return { level: session.thinkingLevel };
      }
      case 'cycle_thinking_level': {
        ensure('cycle_thinking_level');
        return { level: session.cycleThinkingLevel() };
      }
      case 'compact':
        ensure('compact');
        return { result: await session.compact(command.customInstructions) };
      case 'set_auto_compaction':
        ensure('set_auto_compaction');
        session.setAutoCompactionEnabled(command.enabled);
        return undefined;
      case 'get_state':
        ensure('state');
        return { state: await getState() };
      case 'get_messages':
        ensure('state');
        return { messages: readMessages() };
      case 'get_session_stats':
        ensure('meta');
        return { stats: session.getSessionStats() };
      case 'get_session_meta':
        ensure('meta');
        return { meta: await getMeta() };
      case 'get_commands':
        ensure('completion');
        return { commands: await getCommands() };
      case 'complete_args':
        return { items: await completeArgs(command.commandName, command.prefix) };
      case 'complete_file_refs':
        return { items: await completeFileRefsFor(command.prefix) };
      case 'get_tree':
        ensure('tree');
        return getTree();
      case 'navigate_tree': {
        ensure('tree');
        const start: IncomingSdkEvent = { type: 'tree_navigation_start', targetId: command.targetId, summarizing: command.summarize === true };
        mapAndReceive(start);
        try {
          const result = await session.navigateTree(command.targetId, {
            ...(command.summarize !== undefined ? { summarize: command.summarize } : {}),
            ...(command.customInstructions !== undefined ? { customInstructions: command.customInstructions } : {}),
            ...(command.replaceInstructions !== undefined ? { replaceInstructions: command.replaceInstructions } : {}),
            ...(command.label !== undefined ? { label: command.label } : {}),
          });
          return { cancelled: result.cancelled, ...(result.editorText !== undefined ? { editorText: result.editorText } : {}) };
        } finally {
          mapAndReceive({ type: 'tree_navigation_end' });
        }
      }
      case 'set_tree_label':
        ensure('tree');
        session.sessionManager.appendLabelChange(command.entryId, command.label === '' ? undefined : command.label);
        return { success: true };
      case 'set_session_name':
        throw new Error('set_session_name is not available on a session surface');
      default:
        throw new Error(`${type} is not available on a session surface`);
    }
  };

  function getAvailableThinkingLevels(session: BorrowedAgentSession, caps: SessionSurfaceCapabilities): string[] {
    const native = session as BorrowedAgentSession & NativeSessionExtras;
    const levels = typeof native.getAvailableThinkingLevels === 'function' ? native.getAvailableThinkingLevels() : caps.getSettings().availableThinkingLevels;
    return Array.isArray(levels) ? [...levels] : [];
  }

  const getState = async (): Promise<SessionState> => stateFor(options.session, capabilities);

  const getMeta = async (): Promise<SessionMeta> => {
    const context = typeof options.session.getContextUsage === 'function' ? options.session.getContextUsage() : undefined;
    const stats =
      typeof options.session.getSessionStats === 'function'
        ? options.session.getSessionStats()
        : { cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const manager = options.session.sessionManager as unknown as NativeSessionManagerExtras | undefined;
    const rawEntries = manager?.getEntries?.();
    const entries = Array.isArray(rawEntries) ? (rawEntries as SdkSessionEntry[]) : [];
    return {
      gitBranch: capabilities.getGitBranch(),
      contextUsage: context ? { percent: context.percent, contextWindow: context.contextWindow } : null,
      lifetimeCostUsd: typeof stats.cost === 'number' ? stats.cost : 0,
      usageBreakdown: projectSessionUsage(entries, stats),
    };
  };

  const getTree = (): { tree: PimoteTreeNode[]; currentLeafId: string | null } => {
    const manager = options.session.sessionManager as unknown as NativeSessionManagerExtras | undefined;
    const rawTree = manager?.getTree?.();
    const tree = Array.isArray(rawTree) ? (rawTree as SessionTreeNode[]) : [];
    const rawLeaf = manager?.getLeafId?.();
    return { tree: mapTreeNodes(tree), currentLeafId: typeof rawLeaf === 'string' ? rawLeaf : null };
  };

  const getCommands = async (): Promise<readonly CommandInfo[]> => {
    let commands: readonly CommandInfo[] = [];
    if (capabilities.getCommands) commands = await capabilities.getCommands();
    if (options.kind === 'root') return commands;
    // A missing operation projection is the pre-provider compatibility shape.
    // Keep its descriptors for old callers; provider-backed child leases always
    // carry the explicit narrow projection and take the filtered path below.
    if (capabilities.operations === undefined) return commands;
    const filtered = commands.filter((command) => SAFE_CHILD_COMMANDS.has(command.name.replace(/^\//, '').toLowerCase()));
    const names = new Set(filtered.map((command) => command.name.replace(/^\//, '').toLowerCase()));
    const builtins: CommandInfo[] = [
      ...(allowedOperation(options, capabilities, 'tree') ? [{ name: 'tree', description: 'Navigate session history tree', hasArgCompletions: false }] : []),
      ...(allowedOperation(options, capabilities, 'compact') ? [{ name: 'compact', description: 'Manually compact the session context', hasArgCompletions: false }] : []),
    ];
    return [...filtered, ...builtins.filter((command) => !names.has(command.name))];
  };

  const completeArgs = async (commandName: string, prefix: string): Promise<readonly AutocompleteResponseItem[]> => {
    if (options.kind === 'child') {
      if (!allowedOperation(options, capabilities, 'completion')) throw new Error('completion is not available on this child surface');
    }
    const normalized = commandName.replace(/^\//, '').toLowerCase();
    if (options.kind === 'child' && capabilities.operations !== undefined && !SAFE_CHILD_COMMANDS.has(normalized))
      throw new Error(`command ${commandName} is not available on a child surface`);
    return (await capabilities.completeArgs(commandName.replace(/^\//, ''), prefix)) ?? [];
  };

  const completeFileRefsFor = async (prefix: string): Promise<readonly AutocompleteResponseItem[]> => {
    if (options.kind === 'child') {
      if (!allowedOperation(options, capabilities, 'completion')) throw new Error('completion is not available on this child surface');
    }
    return (await capabilities.completeFileRefs(prefix)) ?? [];
  };

  const acceptNativeEvent = (event: IncomingSdkEvent): void => {
    mapAndReceive(event);
  };

  const refreshSnapshot = (): SessionSurfaceSnapshot => {
    if (closed) throw new Error('session surface is closed');
    eventBuffer.invalidateReplay();
    const native = fullMessagesFor(options, capabilities, customEntryVisible);
    projector?.rehydrate(native);
    const partial = mapStreamingMessage(options.session.state?.streamingMessage);
    if (projector && partial) projector.projectStreamingMessage?.(partial);
    providerSnapshot = subagentProvider?.snapshot?.() ?? providerSnapshot;
    const active = activeOperationsForSurface(providerSnapshot?.activeOperations);
    if (projector && active.length > 0) projector.hydrateActiveOperations?.(active);
    return snapshotFor(options, capabilities, eventBuffer.currentCursor, projector, customEntryVisible);
  };

  const initialize = async (): Promise<SessionSurfaceSnapshot> => {
    if (closed) throw new Error('session surface is closed');
    if (initialized) return snapshotFor(options, capabilities, eventBuffer.currentCursor, projector, customEntryVisible);
    ensureSubscription();
    if (subagentProvider && !providerUnsubscribe) providerUnsubscribe = subagentProvider.subscribe(receiveProviderEvent as never);
    initializing = true;
    try {
      // Native reload is the persistence authority. Project the saved branch
      // before provider hydration so provider events have a stable placement.
      projector?.rehydrate(fullMessagesFor(options, capabilities, customEntryVisible));
      const partial = mapStreamingMessage(options.session.state?.streamingMessage);
      if (projector && partial) projector.projectStreamingMessage?.(partial);
      if (projector && options.initialProjection) {
        // A rebuilt child view can retain completed projected blocks while its
        // provider's idempotent hydration remains silent. Restore after the
        // native branch so the retained projection does not erase fresh rows.
        projector.restoreProjection?.(options.initialProjection);
        if (!projector.restoreProjection) projector.rehydrate(options.initialProjection.messages);
        projector.hydrateActiveOperations?.(options.initialProjection.activeOperations);
      }
      const provider = subagentProvider;
      const providerState = provider?.snapshot?.();
      const initialActive = activeOperationsForSurface(providerState?.activeOperations);
      if (projector && initialActive.length > 0) projector.hydrateActiveOperations?.(initialActive);
      if (provider && typeof provider.rehydrate === 'function') await provider.rehydrate({ session: options.session, path: surfacePath });
      const replay = provider?.replay?.();
      if (replay?.kind === 'events') {
        for (const event of replay.events) receiveProviderEvent(event);
      }
      providerSnapshot = provider?.snapshot?.() ?? providerState;
      const hydratedActive = activeOperationsForSurface(providerSnapshot?.activeOperations);
      if (projector && hydratedActive.length > 0) projector.hydrateActiveOperations?.(hydratedActive);
      const snapshot = snapshotFor(options, capabilities, eventBuffer.currentCursor, projector, customEntryVisible);
      initialized = true;
      const pending = staged;
      staged = [];
      // Provider/native events observed during hydration already participate in
      // the projected snapshot. Only events not represented by that snapshot
      // need to cross the first client boundary.
      for (const event of pending) {
        if (!messageIsInSnapshot(event, snapshot)) emit(event);
      }
      return snapshot;
    } finally {
      initializing = false;
    }
  };

  const attachObserver = async (observerId: string, after?: number): Promise<SessionSurfaceAttachment> => {
    const observer = { cursor: after ?? eventBuffer.currentCursor, active: true };
    observers.set(observerId, observer);
    let snapshot: SessionSurfaceSnapshot | undefined;
    let events: readonly PimoteSessionEvent[] | undefined;
    if (after !== undefined) {
      const replay = eventBuffer.replay(after);
      if (replay === null) {
        snapshot = snapshotFor(options, capabilities, eventBuffer.currentCursor, projector, customEntryVisible);
        observer.cursor = eventBuffer.currentCursor;
      } else {
        events = replay;
        observer.cursor = eventBuffer.currentCursor;
      }
    }
    return {
      observerId,
      cursor: observer.cursor,
      ...(snapshot ? { snapshot } : {}),
      ...(events ? { events } : {}),
      release: () => {
        const current = observers.get(observerId);
        if (current === observer) {
          observer.active = false;
          observers.delete(observerId);
        }
      },
    };
  };

  const setSubagentProvider = async (provider: Pick<SubagentPresentationProvider, 'rehydrate' | 'snapshot' | 'subscribe' | 'replay'>): Promise<void> => {
    if (closed) throw new Error('session surface is closed');
    providerUnsubscribe?.();
    providerUnsubscribe = undefined;
    const previousProjection = projector?.snapshot();
    subagentProvider = provider;
    providerSnapshot = provider.snapshot();
    projector = createSubagentTranscriptProjector({
      sessionId: options.sessionId,
      manifest: providerSnapshot.manifest ?? { hiddenToolNames: [], hiddenCustomTypes: [] },
      customEntryVisible,
    });
    projector.rehydrate(fullMessagesFor(options, capabilities, customEntryVisible));
    const partial = mapStreamingMessage(options.session.state?.streamingMessage);
    if (partial) projector.projectStreamingMessage?.(partial);
    if (previousProjection) {
      projector.restoreProjection?.(previousProjection);
      if (!projector.restoreProjection) projector.rehydrate(previousProjection.messages);
      projector.hydrateActiveOperations?.(previousProjection.activeOperations);
    }
    const initialActive = activeOperationsForSurface(providerSnapshot.activeOperations);
    if (initialActive.length > 0) projector.hydrateActiveOperations?.(initialActive);
    providerUnsubscribe = provider.subscribe(receiveProviderEvent);
    if (typeof provider.rehydrate === 'function') await provider.rehydrate({ session: options.session, path: surfacePath });
    const replay = provider.replay?.();
    if (replay?.kind === 'events') {
      for (const event of replay.events) receiveProviderEvent(event);
    }
    providerSnapshot = provider.snapshot();
    const hydrated = activeOperationsForSurface(providerSnapshot.activeOperations);
    if (hydrated.length > 0) projector.hydrateActiveOperations?.(hydrated);
  };

  return {
    sessionId: options.sessionId,
    kind: options.kind,
    get currentCursor() {
      return eventBuffer.currentCursor;
    },
    snapshot() {
      return snapshotFor(options, capabilities, eventBuffer.currentCursor, projector, customEntryVisible);
    },
    initialize,
    acceptNativeEvent,
    acceptProviderEvent(event) {
      if (!providerEventBelongsToSurface(event)) return;
      const projected = projector?.acceptProviderEvent(event) ?? [];
      for (const item of projected) appendProjected(item);
    },
    setSubagentProvider,
    refreshSnapshot,
    subscribe(listener) {
      if (closed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      nativeUnsubscribe?.();
      nativeUnsubscribe = undefined;
      providerUnsubscribe?.();
      providerUnsubscribe = undefined;
      listeners.clear();
      observers.clear();
      staged = [];
    },
    attachObserver,
    replay(after) {
      const cursor = after ?? eventBuffer.currentCursor;
      const events = eventBuffer.replay(cursor);
      if (events === null) return { kind: 'snapshot_required', reason: 'history_unavailable' };
      return { kind: 'events', cursor: eventBuffer.currentCursor, events };
    },
    dispatch,
    getState,
    getMeta,
    async getMessages() {
      return readMessages();
    },
    getCommands,
    completeArgs,
    completeFileRefs: completeFileRefsFor,
  };
}
