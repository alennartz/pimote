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
// The real-speechmux end-to-end run is unblocked by DR-015 (persistent
// LLM-harness listener) and DR-016 (session watchdog). This script is the
// runnable mock slice. See docs/manual-tests/voice-mode.md.

import { VoiceOrchestrator, CallBindError } from '../server/dist/voice-orchestrator.js';
import {
  initialRuntimeState,
  reduceActivate,
  reduceDeactivate,
  reduceSpeechmuxFrame,
  reduceSpeechmuxOpened,
} from '../server/dist/voice/extension-runtime.js';
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

  const displaceCalls = [];

  /** @type {VoiceOrchestrator} */
  let orchestrator;
  orchestrator = new VoiceOrchestrator({
    config: {
      roots: ['/tmp'],
      idleTimeout: 1000,
      bufferSize: 10,
      port: 3000,
      voice: { speechmuxLlmWsUrl: 'ws://mock/llm', speechmuxSignalUrl: 'wss://mock/signal' },
    },
    sessionManager: {},
    busResolver: {
      getSlot: (id) => (id === 's-1' ? slot : null),
      getEventBus: (id) => (id === 's-1' ? bus : null),
    },
    startSpeechmux: async () => {},
    stopSpeechmux: async () => {},
    // Mirror ws-handler's real displacement path: tear down orchestrator
    // bookkeeping for the old owner before the new bind proceeds.
    displaceOwner: async (sessionId, newOwner) => {
      displaceCalls.push({ sessionId, newOwnerId: newOwner.connectedClientId });
      await orchestrator.endCall({ sessionId, reason: 'displaced' });
    },
    isOwnedByVoiceCall: (sessionId) => orchestrator.isCallActive(sessionId),
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
  assert(data.webrtcSignalUrl === 'wss://mock/signal', 'bindCall returned the signal URL');
  assert(!('callToken' in data), 'bindCall no longer returns a per-call auth token (speechmux owns auth via Cloudflare Access)');
  assert(!('turn' in data), 'bindCall no longer returns TURN creds (speechmux mints per-session TURN in /signal session response)');
  assert(bus.emitted.length === 1, 'bus received exactly one event');
  assert(bus.emitted[0].type === 'pimote:voice:activate', 'event type is pimote:voice:activate');
  assert(!('callToken' in bus.emitted[0].payload), 'activate payload no longer carries a callToken');
  assert(bus.emitted[0].payload.speechmuxWsUrl === 'ws://mock/llm', 'activate payload carries the LLM-WS URL');
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

  // --- 3b. UI-bridge gating predicate -------------------------------------
  console.log('\n[mock] 3b. UI-bridge gating predicate');
  // Mirrors the predicate ws-handler.ts passes to createExtensionUIBridge:
  //   isVoiceModeActive: () => voiceOrchestrator.isCallActive(sessionId)
  // Gating lives in extension-ui-bridge.ts (unit-tested there); this smoke
  // verifies the predicate's booleans reflect orchestrator state correctly
  // across the call lifecycle.
  const isVoiceModeActive = () => orchestrator.isCallActive('s-1');
  assert(isVoiceModeActive() === true, 'predicate true while call is active');
  const isOtherVoiceModeActive = () => orchestrator.isCallActive('s-other');
  assert(isOtherVoiceModeActive() === false, 'predicate false for sessions without a call');

  // --- 4. endCall ----------------------------------------------------------
  console.log('\n[mock] 4. endCall -> deactivate emitted');
  await orchestrator.endCall({ sessionId: 's-1', reason: 'user_hangup' });
  assert(orchestrator.isCallActive('s-1') === false, 'isCallActive false after endCall');
  assert(bus.emitted.filter((e) => e.type === 'pimote:voice:deactivate').length === 1, 'single deactivate emitted');
  assert(isVoiceModeActive() === false, 'predicate flips false after call ends — UI bridge re-enabled');

  // Idempotency: repeated endCall is a no-op.
  await orchestrator.endCall({ sessionId: 's-1', reason: 'user_hangup' });
  assert(
    bus.emitted.filter((e) => e.type === 'pimote:voice:deactivate').length === 1,
    'repeated endCall is idempotent (no extra deactivate)',
  );
  // endCall on unbound session is a no-op and does not throw.
  await orchestrator.endCall({ sessionId: 's-none', reason: 'user_hangup' });

  // --- 5. bindCall error paths --------------------------------------------
  console.log('\n[mock] 5. bindCall error paths');
  let caught;
  try {
    await orchestrator.bindCall({
      sessionId: 's-unknown',
      clientConnection: { ws: {}, connectedClientId: 'c-x', onSessionReset: null },
      force: false,
    });
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof CallBindError, 'unknown session throws CallBindError');
  assert(caught?.code === 'call_bind_failed_session_not_found', 'unknown session code = call_bind_failed_session_not_found');

  // Prime a new call to test call_bind_failed_owned.
  await orchestrator.bindCall({
    sessionId: 's-1',
    clientConnection: { ws: {}, connectedClientId: 'c-A', onSessionReset: null },
    force: false,
  });
  caught = undefined;
  try {
    await orchestrator.bindCall({
      sessionId: 's-1',
      clientConnection: { ws: {}, connectedClientId: 'c-B', onSessionReset: null },
      force: false,
    });
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof CallBindError, 'owned session without force throws');
  assert(caught?.code === 'call_bind_failed_owned', 'owned session without force code = call_bind_failed_owned');

  // --- 6. Displacement path (force: true) ---------------------------------
  console.log('\n[mock] 6. displacement with force:true');
  const busCountBefore = bus.emitted.length;
  await orchestrator.bindCall({
    sessionId: 's-1',
    clientConnection: { ws: {}, connectedClientId: 'c-B', onSessionReset: null },
    force: true,
  });
  assert(displaceCalls.length === 1, 'displaceOwner seam invoked once');
  assert(displaceCalls[0].sessionId === 's-1', 'displaceOwner invoked with the right sessionId');
  assert(displaceCalls[0].newOwnerId === 'c-B', 'displaceOwner handed the new owner');
  const newEvents = bus.emitted.slice(busCountBefore);
  assert(
    newEvents.some((e) => e.type === 'pimote:voice:deactivate'),
    'displacement emits deactivate for the old owner',
  );
  assert(
    newEvents.some((e) => e.type === 'pimote:voice:activate' && e.payload.sessionId === 's-1'),
    'displacement emits activate for the new owner',
  );
  assert(orchestrator.isCallActive('s-1') === true, 'displacement leaves exactly one active call');

  // Simulate the real-server side effect: the ws-handler's sendDisplacedEvent
  // broadcasts `call_ended { reason: 'displaced' }` to the first client. The
  // orchestrator doesn't emit that wire event itself (the ws-handler does);
  // what the orchestrator owns is the bus-side deactivate asserted above.

  // Clean up: end the displacing call.
  await orchestrator.endCall({ sessionId: 's-1', reason: 'user_hangup' });
  assert(orchestrator.isCallActive('s-1') === false, 'post-displacement call ends cleanly');

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
