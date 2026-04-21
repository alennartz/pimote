#!/usr/bin/env node
// Mock-speechmux smoke for pimote voice mode.
//
// Exercises the pimote-side voice pipeline end-to-end **without** a real
// speechmux binary or WebSocket:
//
//   1. Boot a VoiceOrchestrator with fake seams.
//   2. bindCall a fake session -> assert pimote:voice:activate on the bus.
//   3. Drive the pure extension-runtime reducers with synthetic speechmux
//      frames (user / rollback) and assert the produced VoiceAction[].
//   4. endCall -> assert pimote:voice:deactivate.
//
// The real-speechmux end-to-end run stays blocked on speechmux-repo changes
// (startup-time LlmBackend listener + per-call /signal tokens). This script
// is the runnable slice of Step 14. See docs/manual-tests/voice-mode.md.

import { VoiceOrchestrator } from '../server/dist/voice-orchestrator.js';
import {
  initialRuntimeState,
  reduceActivate,
  reduceDeactivate,
  reduceSpeechmuxFrame,
  reduceSpeechmuxOpened,
} from '../packages/voice/dist/extension-runtime.js';
import { VOICE_INTERRUPT_CUSTOM_TYPE } from '../shared/dist/index.js';

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.error(`  ✗ ${msg}`);
    failures++;
  }
}

function makeBus() {
  const emitted = [];
  const listeners = new Map();
  return {
    emitted,
    emit(type, payload) {
      emitted.push({ type, payload });
      for (const l of listeners.get(type) ?? []) l(payload);
    },
    on(type, handler) {
      const arr = listeners.get(type) ?? [];
      arr.push(handler);
      listeners.set(type, arr);
      return () => {};
    },
    clear() {
      listeners.clear();
    },
  };
}

async function main() {
  console.log('[mock] pimote voice-mode smoke');

  // --- 1. orchestrator boot ------------------------------------------------
  console.log('\n[mock] 1. orchestrator lifecycle');
  const bus = makeBus();
  const slot = { sessionState: { id: 's-1' } };

  const orchestrator = new VoiceOrchestrator({
    config: {
      roots: ['/tmp'],
      idleTimeout: 1000,
      bufferSize: 10,
      port: 3000,
      voice: { speechmuxLlmWsUrl: 'ws://mock/llm' },
    },
    sessionManager: {},
    busResolver: {
      getSlot: (id) => (id === 's-1' ? slot : null),
      getEventBus: (id) => (id === 's-1' ? bus : null),
    },
    mintCallToken: async () => ({
      token: 'mock-token',
      turn: { urls: ['turn:mock'], username: 'u', credential: 'c' },
      webrtcSignalUrl: 'wss://mock/signal',
    }),
    startSpeechmux: async () => {},
    stopSpeechmux: async () => {},
    displaceOwner: async () => {},
    isOwnedByVoiceCall: () => false,
  });

  await orchestrator.start();
  console.log('  [mock] started orchestrator');

  // --- 2. bindCall ---------------------------------------------------------
  console.log('\n[mock] 2. bindCall -> activate emitted');
  const data = await orchestrator.bindCall({
    sessionId: 's-1',
    clientConnection: { ws: {}, connectedClientId: 'c-1', onSessionReset: null },
    force: false,
  });
  assert(data.callToken === 'mock-token', 'bindCall returned the minted token');
  assert(data.webrtcSignalUrl === 'wss://mock/signal', 'bindCall returned the signal URL');
  assert(bus.emitted.length === 1, 'bus received exactly one event');
  assert(bus.emitted[0].type === 'pimote:voice:activate', 'event type is pimote:voice:activate');
  assert(bus.emitted[0].payload.callToken === 'mock-token', 'activate payload carries the token');
  assert(orchestrator.isCallActive('s-1') === true, 'isCallActive true after bindCall');
  console.log('  [mock] bindCall emitted pimote:voice:activate on bus');

  // --- 3. extension-runtime reducers --------------------------------------
  console.log('\n[mock] 3. extension-runtime frame handling');
  const runtimeConfig = {
    defaultInterpreterModel: { provider: 'mock', modelId: 'mock-model' },
  };
  let state = initialRuntimeState();

  const act = reduceActivate(state, bus.emitted[0].payload, runtimeConfig);
  state = act.next;
  assert(state.state === 'activating', 'state is activating after reduceActivate');
  assert(act.actions.some((a) => a.kind === 'open_speechmux'), 'open_speechmux action emitted');

  const opened = reduceSpeechmuxOpened(state, runtimeConfig);
  state = opened.next;
  assert(state.state === 'active', 'state is active after speechmux opened');
  assert(opened.actions.some((a) => a.kind === 'set_model'), 'set_model emitted on first activation');
  assert(
    opened.actions.some((a) => a.kind === 'send_user_message' && a.text === '<voice_call_started/>'),
    '<voice_call_started/> sentinel emitted',
  );
  console.log('  [mock] extension transitioned dormant -> activating -> active');

  const userFrame = reduceSpeechmuxFrame(state, { type: 'user', text: 'hello pimote' });
  assert(
    userFrame.actions.some((a) => a.kind === 'send_user_message' && a.text === 'hello pimote'),
    'user frame -> send_user_message',
  );
  console.log('  [mock] speechmux user frame -> session.sendUserMessage');

  const rollbackFrame = reduceSpeechmuxFrame(state, { type: 'rollback', heard_text: 'hi th' });
  assert(rollbackFrame.actions.some((a) => a.kind === 'abort'), 'rollback emits abort');
  assert(
    rollbackFrame.actions.some((a) => a.kind === 'set_walkback_watermark' && a.heardText === 'hi th'),
    'rollback sets walkback watermark',
  );
  assert(
    rollbackFrame.actions.some(
      (a) => a.kind === 'append_custom_entry' && a.customType === VOICE_INTERRUPT_CUSTOM_TYPE && a.data.kind === 'rollback' && a.data.heard_text === 'hi th',
    ),
    'rollback appends pimote:voice:interrupt custom entry',
  );
  console.log('  [mock] speechmux rollback frame -> abort + watermark + custom entry');

  // --- 4. endCall ----------------------------------------------------------
  console.log('\n[mock] 4. endCall -> deactivate emitted');
  await orchestrator.endCall({ sessionId: 's-1', reason: 'user_hangup' });
  assert(orchestrator.isCallActive('s-1') === false, 'isCallActive false after endCall');
  assert(bus.emitted.filter((e) => e.type === 'pimote:voice:deactivate').length === 1, 'single deactivate emitted');

  const deact = reduceDeactivate(state, { type: 'pimote:voice:deactivate', sessionId: 's-1' });
  state = deact.next;
  assert(state.state === 'dormant', 'state is dormant after reduceDeactivate');
  assert(deact.actions.some((a) => a.kind === 'close_speechmux'), 'close_speechmux emitted on deactivate');
  console.log('  [mock] endCall emitted pimote:voice:deactivate');

  await orchestrator.stop();

  console.log('');
  if (failures === 0) {
    console.log('[mock] all assertions passed');
    process.exit(0);
  } else {
    console.error(`[mock] ${failures} assertion(s) failed`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[mock] unexpected failure:', err);
  process.exit(1);
});
