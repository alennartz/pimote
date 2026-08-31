# Manual Testing — bang-bash-command

## Smoke Suite

- **Connect and open a session (journey 1):** verify the real server/PWA can boot, connect, list/open a session, and reach the composer used by bang commands.
- **Prompt → streamed assistant response (journey 2, scoped):** verify the session surface and composer remain usable while the model stream path is active; the focused run emphasizes bash submitted during streaming rather than unrelated prompt features.

The remaining persistent journeys are out of scope for this topic and are not exercised here, per the focus hints.

## Topic-Specific Tests

1. Leading `!` parses and dispatches a context-visible native bash command.
2. Leading `!!` parses and dispatches a context-excluded native bash command, with distinct presentation and resync semantics.
3. Native bash output streams live, renders bounded output/status, and final results preserve exit/cancel/truncation metadata.
4. Bash can execute during model streaming without becoming a steer or blocking the model stream.
5. Bash cancellation is independent from model abort and leaves a cancelled result.
6. A second bash is rejected while one is running; extension user-bash interception is honored when available.
7. Reconnect/disconnect recovery preserves an accepted running command, avoids duplicate dispatch, and reconciles via full resync.

## Tools

- Reused: `npm run build`; direct WebSocket probes via `node`/`bash`; `agent-browser` where available.
- New: none.
- Improved: none.

## Harness Limitations

The repository has no existing bang-specific manual-test driver. The focused run uses a real built server and PWA plus direct WebSocket protocol probes, but no live LLM credentials/model stream or extension fixture is guaranteed in this environment. Therefore model-stream concurrency and extension interception are checked at the protocol/handler boundary where possible, while a true provider-generated stream and extension-owned result remain environment-bounded. Browser checks require an installed `agent-browser` binary and a sandboxed pi session; synthetic session fixtures cannot prove provider latency or multi-client races.

## Results

_To be filled after execution._

## Plan Updates

Empty — no new primary journey or persistent tool is introduced by this run.

## Open Issues

_To be filled after execution._
