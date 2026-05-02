// Client-side voice/call diagnostic trace helper.
//
// Buffers structured log entries and ships them to the pimote server via the
// `client_log` PimoteCommand, where they merge into the same journalctl
// stream as server-side voice extension logs. Strictly diagnostic — the
// server forwards them to console (no persistence).
//
// Activate by importing `voiceTrace` from this module and calling it like:
//
//   voiceTrace('webrtc', 'iceconnectionstatechange', { state: pc.iceConnectionState });
//
// Logs are also mirrored to the browser console so they're visible in DevTools.

import type { ClientLogCommand, PimoteCommand, PimoteResponse } from '@pimote/shared';

type SendFn = (cmd: PimoteCommand) => Promise<PimoteResponse<unknown>>;

let sender: SendFn | null = null;
const pending: ClientLogCommand[] = [];
const PENDING_CAP = 500;

/** Wire the trace helper to the connection store's `send` once it's available. */
export function configureVoiceTrace(send: SendFn): void {
  sender = send;
  // Flush whatever queued up before the connection was ready.
  const drained = pending.splice(0, pending.length);
  for (const cmd of drained) {
    send(cmd).catch((err) => console.warn('[voice_trace] flush failed', err));
  }
}

interface VoiceTraceData {
  data?: Record<string, unknown>;
  level?: 'debug' | 'info' | 'warn' | 'error';
}

/** Log a structured trace entry for the voice/call pipeline. */
export function voiceTrace(tag: string, message: string, opts: VoiceTraceData = {}): void {
  const cmd: ClientLogCommand = {
    type: 'client_log',
    level: opts.level ?? 'info',
    tag,
    message,
    clientTimestampMs: Date.now(),
    data: opts.data,
  };
  // Mirror to browser console for DevTools visibility.
  const consoleArgs = [`[voice_trace][${tag}] ${message}`, opts.data ?? ''];
  switch (cmd.level) {
    case 'error':
      console.error(...consoleArgs);
      break;
    case 'warn':
      console.warn(...consoleArgs);
      break;
    default:
      console.log(...consoleArgs);
      break;
  }
  if (sender) {
    sender(cmd).catch((err) => console.warn('[voice_trace] send failed', err));
  } else {
    if (pending.length < PENDING_CAP) pending.push(cmd);
  }
}
