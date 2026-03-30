# DR-001: SDK Embedding Over RPC Mode for Pi Integration

## Status

Accepted

## Context

The initial brainstorm for Pimote's server architecture chose to integrate with pi by spawning `pi --mode rpc` as a subprocess. This approach was favored for process isolation and loose coupling, as the RPC protocol provides a well-defined JSON interface over stdio.

During the architecture phase, a deeper investigation into the `@mariozechner/pi-coding-agent` SDK revealed the `AgentSession` class, which allows for direct embedding of a pi session within a Node.js process. This presented a clear alternative with a different set of trade-offs.

## Decision

We chose to use direct `AgentSession` SDK embedding instead of spawning `pi --mode rpc` subprocesses.

This decision was driven by the significant simplification it offered for the server's implementation:

- **No Subprocess Management:** It eliminates the need to manage the lifecycle of child processes (spawning, monitoring, restarting).
- **No Serialization Layer:** It removes the need for a JSONL framing layer to serialize/deserialize messages to the subprocess's stdio streams. Communication is via direct, typed method calls.
- **Clean Extension UI Bridging:** The SDK's `session.bindExtensions({ uiContext })` provides a first-class mechanism for bridging extension UI calls. Implementing a custom `ExtensionUIContext` that translates these calls into WebSocket messages is substantially cleaner than creating a relay protocol to shuffle extension UI requests/responses between the main process and an RPC subprocess.
- **Direct Session Discovery:** The SDK's `SessionManager` provides a direct API for discovering and managing session files, simplifying the server's folder and session indexing logic.

## Consequences

- The primary trade-off is the loss of process isolation. An unhandled exception within a pi session could theoretically crash the entire Pimote server process. This was deemed an acceptable risk because pi sessions are generally stable and do not crash in normal operation.
- The server is now more tightly coupled to the pi SDK's Node.js API. This is a reasonable trade-off given that the server's entire purpose is to host pi sessions.
- Future changes to pi's core that are not exposed via the `AgentSession` API will not be available to Pimote until the SDK is updated.
