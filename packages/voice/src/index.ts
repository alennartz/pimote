// @pimote/voice — voice extension for pimote.
//
// See docs/plans/voice-mode.md for the architectural contract.

import type { ExtensionFactory } from '@mariozechner/pi-coding-agent';
import type { SpeechmuxClientFactory } from './speechmux-client.js';

export { walkBack, isAbortedEmptyAssistant } from './walk-back.js';
export type { WalkBackInput, ContentBlock, SpeakToolUseBlock, OtherBlock } from './walk-back.js';
export type { VoiceExtensionState, VoiceActivateMessage, VoiceDeactivateMessage } from './state-machine.js';
export { VOICE_CALL_STARTED_SENTINEL } from './state-machine.js';
export type { SpeechmuxClient, SpeechmuxClientFactory, IncomingFrame, OutgoingFrame, SpeechmuxClientFactoryOptions } from './speechmux-client.js';
export * from './extension-runtime.js';

/** Model reference used for interpreter / worker defaults. */
export interface ModelRef {
  provider: string;
  modelId: string;
}

export interface CreateVoiceExtensionOptions {
  defaultInterpreterModel: ModelRef;
  defaultWorkerModel: ModelRef;
  /** Optional client factory override — tests inject a fake. */
  speechmuxClientFactory?: SpeechmuxClientFactory;
}

/**
 * Factory for the pimote voice extension. The returned ExtensionFactory
 * registers the `speak` tool, the interpreter-prompt hook, the walk-back
 * context hook, the message_update capture subscriber, and listens for
 * `pimote:voice:activate` / `pimote:voice:deactivate` EventBus messages.
 *
 * Implementation lives in test-write as a stub that throws `not implemented`.
 */
export function createVoiceExtension(_opts: CreateVoiceExtensionOptions): ExtensionFactory {
  return () => {
    throw new Error('createVoiceExtension: not implemented');
  };
}
