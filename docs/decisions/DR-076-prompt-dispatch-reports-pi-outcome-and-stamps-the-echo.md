# DR-076: Prompt dispatch reports pi's outcome and stamps the echo

## Status

Accepted

## Context

The composer shows a sent prompt at once as an optimistic entry and replaces it when pi echoes the user message. Under shared observers (DR-067), several clients send into one session, so a client must tell its own echo from another client's. Commit `7929c82` matched echoes by exact text against a FIFO of pending entries, and inserted every other confirmed message ahead of the oldest pending entry to keep server order.

Text matching failed silently, and a failed match was permanent. Extension commands (`/quota`) never echo. Skill and template expansion and input handlers (`autoflow-autostart`) echo different text. `prompt()` could throw after the server had already answered success. Each case stranded an entry at the front of the FIFO, and every later message was inserted above it. On a phone this looked like each new turn vanishing on `message_end`, for as long as the session lived. `steer` and `follow_up` had the same flaw: they answered success before pi accepted the message, so a rejected steer left a pending pill that nothing cleared.

## Decision

Make the server authoritative for both questions the client was guessing: did pi accept the input, and which echo is mine.

- `prompt`, `steer`, and `follow_up` all go through pi's `prompt()` with a `streamingBehavior`, and the server awaits pi's preflight. The response reports a `PromptOutcome`: `started`, `queued`, or `handled`. A refusal before dispatch becomes an error response.
- A prompt carries a sender-chosen `clientMessageId`. In pi's `started` preflight, which runs after pi prepares the run's messages and before it emits them, the event buffer arms a one-shot stamp. The next user `message_start` and `message_end` carry the id, live and in replay.
- The client reconciles by id. It keeps the entry only for `started`, removes it for `queued`, `handled`, a rejection, or a lost connection, and drops the steer pill unless the outcome is `queued`.
- Slash input gets no optimistic entry and no id, and the server answers it at once without an outcome. pi reports an extension command only after its handler finishes, and a handler can wait on a dialog.

Rejected alternatives:

- **Keep text matching and skip optimistic entries for slash input on the client.** This covered `/quota` and `/skill:` but not input-handler rewrites or `prompt()` throws, and it left `steer` and `follow_up` unfixed.
- **Let the next user echo replace the front entry regardless of text.** This was the pre-`7929c82` rule. It breaks as soon as another observer's prompt echoes first.
- **Correlate on the server by queue text.** pi's queues hold expanded text, so this inherits the same mismatch. The queue-ownership ledger still uses text, with a fallback to the oldest submission of the same kind.

## Consequences

- An optimistic entry now ends in one of two ways: its stamped echo replaces it, or the outcome removes it. No path leaves it stranded.
- **Slower response:** a prompt's response arrives after pi's input handlers run. That is still fast in practice, but slower than the old immediate reply.
- **Idle steer starts a run:** a `steer` or `follow_up` that reaches an idle session now starts a run. Before, it waited in the queue for the next prompt.
- **One stamp per buffer:** this relies on pi starting at most one run at a time, so a concurrent prompt is `queued`, not `started`. If pi ever starts runs concurrently, the stamp needs a queue.
- **Unstamped echoes:** a queued prompt's echo arrives unstamped and appends like a foreign message. Its pending pill comes from pi's `queue_update` snapshot.
- **Wire additions:** `PromptCommand.clientMessageId`, `PromptOutcome`, `PromptResponseData`, and `clientMessageId` on `message_start` and `message_end`. Android sends no prompts and ignores unknown fields.
