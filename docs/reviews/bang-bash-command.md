# Review: Native `!` Bash Commands

**Plan:** `docs/plans/bang-bash-command.md`  
**Diff range:** `683ec2607d742b3781b228157778f2d16859c066..3d7553bdb314a757cdc593aa06cf7f9607374ba3`  
**Date:** 2026-08-31

## Summary

The implementation follows the plan across the protocol, native SDK routing, client reduction, composer, and presentation layers, and no significant plan deviations were found. The planned test files remain immutable after the pre-implementation baseline. Correctness review found one critical concurrency race plus four warnings involving reconnect state, streaming message order, idle reaping, and unbounded live-output handling.

## Findings

### 1. Bash admission is not atomic across extension interception

- **Category:** code correctness
- **Severity:** critical
- **Location:** `server/src/ws-handler.ts:915-947`
- **Status:** open

Each WebSocket message is handled independently, but this branch checks `session.isBashRunning` only before awaiting the asynchronous `emitUserBash()` hook. Two requests can therefore pass the check while the first hook is pending (and extension-handled paths never set the native running flag), then both execute or record a command. An `abort_bash` received during that interception window can also return successfully before a process exists, leaving the later command uncancelled.

### 2. A dropped socket turns an accepted command into a stale dispatch error

- **Category:** code correctness
- **Severity:** warning
- **Location:** `client/src/lib/components/InputBar.svelte:259-276`; `client/src/lib/stores/session-registry.svelte.ts:736-787`; `server/src/event-buffer.ts:326-333`
- **Status:** open

`connection.send()` rejects all pending requests when the socket closes, even if the server has already accepted and started the bash command. The catch path marks the transient entry as a terminal error, which removes its Cancel action and causes subsequent live deltas to be ignored. The server leaves the command running after owner disconnect, while bash deltas are not replayed; an incremental reconnect can therefore show a failed or missing command and invite duplicate execution before a durable result is observed.

### 3. Completion during model streaming is inserted in the wrong order

- **Category:** code correctness
- **Severity:** warning
- **Location:** `client/src/lib/stores/session-registry.svelte.ts:748-772`; `client/src/lib/components/MessageList.svelte:145-165`
- **Status:** open

Pi's native `recordBashResult()` defers persistence while the agent is streaming, but `completeBash()` immediately appends a finalized bash message to the client list. `MessageList` renders finalized messages before the active streaming message, so a command submitted during a model turn jumps ahead of the assistant output. The extra local message also participates in the later positional `messageEntryIds` assignment, shifting fork targets until a full resync replaces the list.

### 4. Idle reaping can close a session during a standalone bash command

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/ws-handler.ts:915-948`; `server/src/session-manager.ts:760-765`
- **Status:** open

A standalone bash execution does not emit `agent_start` or otherwise clear the slot's `idleSince`. If an idle session loses its owner while a long command is running, the idle checker still sees the old idle timestamp and no connected client, and can close the session after the timeout, aborting the command and losing its live result.

### 5. Live output storage and preview are not bounded by bytes

- **Category:** code correctness
- **Severity:** warning
- **Location:** `client/src/lib/stores/session-registry.svelte.ts:727-744`; `client/src/lib/components/BashExecution.svelte:93-95`
- **Status:** open

The reducer concatenates every streamed delta into one string, and the renderer repeatedly splits that complete string on every update. The ten-line preview does not cap bytes, so high-volume output or one very long line can consume unbounded browser memory/CPU and bypass the collapsed preview. Native truncation only arrives in the final result, after the transient client state has already accumulated the full stream.

## No Issues

Plan adherence: no significant deviations found. The test files listed in the plan were not modified between `55ca43f02b805e960e6ec4135e2eb6243ad1753e` and `HEAD`; the plan's test immutability requirement is satisfied.
