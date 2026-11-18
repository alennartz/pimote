import { randomUUID } from 'node:crypto';
import type { FullResyncEvent, FullResyncStartEvent, PimoteSurfaceEvent, PimoteEvent, RestoreMode } from '../../shared/dist/index.js';
import type { SessionSurface, SessionSurfaceSync } from './session-surface.js';

const MAX_FRAME_BYTES = 256 * 1024;
const JSON_CHUNK_BYTES = 32 * 1024;

type SendFrame = (event: PimoteSurfaceEvent) => boolean;

function* jsonFragments(parts: Iterable<string>): Generator<{ offset: number; data: string; final: boolean }> {
  let data = '';
  let bytes = 0;
  let position = 0;
  for (const part of parts) {
    for (let offset = 0; offset < part.length; ) {
      let end = Math.min(offset + 8192, part.length);
      const last = part.charCodeAt(end - 1);
      if (end < part.length && last >= 0xd800 && last <= 0xdbff) end--;
      const piece = part.slice(offset, end);
      const pieceBytes = Buffer.byteLength(piece);
      if (bytes > 0 && bytes + pieceBytes > JSON_CHUNK_BYTES) {
        yield { offset: position, data, final: false };
        position += data.length;
        data = '';
        bytes = 0;
      }
      data += piece;
      bytes += pieceBytes;
      offset = end;
    }
  }
  yield { offset: position, data, final: true };
}

function* messageJson(messages: FullResyncEvent['messages']): Generator<string> {
  yield '[';
  for (const [index, message] of messages.entries()) {
    if (index > 0) yield ',';
    yield JSON.stringify(message);
  }
  yield ']';
}

export function sendFullResync(snapshot: FullResyncEvent, send: SendFrame): boolean {
  let bytes = Buffer.byteLength(JSON.stringify({ ...snapshot, messages: [], branchEntryIds: [] }));
  for (const message of snapshot.messages) {
    bytes += Buffer.byteLength(JSON.stringify(message)) + 1;
    if (bytes > MAX_FRAME_BYTES) break;
  }
  if (bytes <= MAX_FRAME_BYTES) {
    for (const id of snapshot.branchEntryIds ?? []) {
      bytes += Buffer.byteLength(JSON.stringify(id)) + 1;
      if (bytes > MAX_FRAME_BYTES) break;
    }
  }
  if (bytes <= MAX_FRAME_BYTES) return send(snapshot);

  const { type: _type, messages, branchEntryIds, streamingMessage, activeSubagentContent, runningToolCallIds, ...state } = snapshot;
  const sessionId = snapshot.sessionId;
  const snapshotId = randomUUID();
  const start: FullResyncStartEvent = {
    ...state,
    type: 'full_resync_start',
    snapshotId,
    totalMessages: messages.length,
    ...(branchEntryIds !== undefined ? { totalBranchEntryIds: branchEntryIds.length } : {}),
    ...(streamingMessage !== undefined ? { hasStreamingMessage: true } : {}),
    ...(activeSubagentContent !== undefined ? { hasActiveSubagentContent: true } : {}),
    ...(runningToolCallIds !== undefined ? { hasRunningToolCallIds: true } : {}),
  };
  if (!send(start)) return false;
  for (const chunk of jsonFragments(messageJson(messages))) {
    if (!send({ type: 'full_resync_json_chunk', sessionId, snapshotId, ...chunk })) return false;
  }
  if (branchEntryIds !== undefined) {
    let ids: string[] = [];
    let idBytes = 2;
    let offset = 0;
    for (const id of branchEntryIds) {
      const encodedBytes = Buffer.byteLength(JSON.stringify(id)) + 1;
      if (ids.length > 0 && idBytes + encodedBytes > MAX_FRAME_BYTES - 1024) {
        if (!send({ type: 'full_resync_branch_chunk', sessionId, snapshotId, offset, ids })) return false;
        offset += ids.length;
        ids = [];
        idBytes = 2;
      }
      ids.push(id);
      idBytes += encodedBytes;
    }
    if (ids.length > 0 && !send({ type: 'full_resync_branch_chunk', sessionId, snapshotId, offset, ids })) return false;
  }
  const fields = { streamingMessage, activeSubagentContent, runningToolCallIds };
  for (const field of Object.keys(fields) as (keyof typeof fields)[]) {
    if (fields[field] === undefined) continue;
    for (const chunk of jsonFragments([JSON.stringify(fields[field])])) {
      if (!send({ type: 'full_resync_data_chunk', sessionId, snapshotId, field, ...chunk })) return false;
    }
  }
  return true;
}

function sendSyncPayload(surface: SessionSurface, sync: SessionSurfaceSync, send: SendFrame, mode: RestoreMode): boolean {
  const sessionId = surface.sessionId;
  if (!send({ type: 'session_restore', sessionId, mode, status: 'started' })) return false;
  if (sync.snapshot && !sendFullResync({ ...sync.snapshot, type: 'full_resync', sessionId }, send)) return false;
  if (sync.events && !send({ type: 'buffered_events', sessionId, events: [...sync.events] })) return false;
  if (!send({ type: 'connection_restored', sessionId, cursor: sync.cursor, state: sync.state })) return false;
  return send({ type: 'session_restore', sessionId, mode, status: 'completed' });
}

export class SessionEventGate {
  private pending: PimoteEvent[] = [];
  private ready = false;
  private covered?: { cursor: number; snapshot: boolean; runningToolCallIds: readonly string[] };
  private replayed = new Set<number>();

  constructor(private readonly forward: (event: PimoteEvent) => boolean) {}

  send(event: PimoteEvent): boolean {
    if (event.type === 'event_batch') return event.events.map((item) => this.send(item)).every(Boolean);
    if (!this.ready) {
      if (event.type === 'queued_drafts_restored') return false;
      this.pending.push(event);
      return true;
    }
    return this.coveredBySync(event) || this.forward(event);
  }

  private coveredBySync(event: PimoteEvent): boolean {
    const sync = this.covered;
    if (!sync || !('cursor' in event) || typeof event.cursor !== 'number' || event.cursor > sync.cursor) return false;
    if (sync.snapshot) {
      if (event.type === 'extension_error') return false;
      if (event.type === 'tool_execution_update' && sync.runningToolCallIds.includes(event.toolCallId)) return false;
      return true;
    }
    return this.replayed.has(event.cursor) || event.type === 'message_update' || event.type === 'subagent_content_delta';
  }

  synchronize(surface: SessionSurface, clientId: string, after?: number, noCursorMode: RestoreMode = 'full_resync_no_cursor'): { mode: RestoreMode; cursor: number } {
    const sync = surface.sync(after);
    const mode = sync.events ? 'incremental_replay' : after === undefined ? noCursorMode : 'full_resync_cursor_stale';
    const delivered = sendSyncPayload(surface, sync, this.forward, mode);
    if (!delivered) throw new Error('WebSocket delivery failed');
    this.covered = { cursor: sync.cursor, snapshot: sync.snapshot !== undefined, runningToolCallIds: sync.snapshot?.runningToolCallIds ?? [] };
    this.replayed = new Set(sync.events?.flatMap((event) => ('cursor' in event ? [event.cursor] : [])) ?? []);
    this.ready = true;
    const pending = this.pending;
    this.pending = [];
    for (const event of pending) if (event.type !== 'session_settings_changed') this.send(event);
    surface.restoreQueuedDrafts(clientId);
    return { mode, cursor: sync.cursor };
  }

  flush(): void {
    this.ready = true;
    const pending = this.pending;
    this.pending = [];
    for (const event of pending) this.forward(event);
  }
}
