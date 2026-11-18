# Activity

The activity module lets an extension veto Pimote's idle reaper. Register a responder if your extension owns work the root session cannot see, such as background subagents that keep running after the root turn settles.

## When Pimote closes a session

Pimote closes sessions that hold no work. It checks every 60 seconds and closes a session whose idle time exceeds `idleTimeout`, which defaults to 30 minutes.

A session is busy, and stays open, while any of these holds:

- A browser observes it.
- A voice call is active.
- A bash command runs, or a bash dispatch is in flight.
- Tree navigation is in progress.
- A turn has not settled.
- An extension reports activity through this module.

Before closing, Pimote polls every extension in the session and reads the answer synchronously. A session whose extensions answer `true` stays open, and the next check re-asks.

The same poll decides whether a session yields to archiving or to a hub disband, so a responder that always answers `true` keeps its sessions alive across those operations.

## Register a responder

```ts
import { answerActivity } from '@pimote/sdk/activity';

answerActivity(pi, () => myAgents.some((agent) => agent.state === 'running'));
```

`answerActivity(pi, isActive)` registers one responder on the session's EventBus and returns a function that removes it. The bus dies with the session, so the unsubscribe exists mainly for tests.

The callback must be synchronous. The round-trip is an inline emit, so an answer that arrives later is indistinguishable from no answer.

The callback runs at poll time, not at registration time. Read live state through a stable owner object instead of capturing a value.

A callback that throws answers `active: true`, so a broken predicate parks the session instead of destroying work. Pimote logs the throw.

## Several responders

Extensions answer independently, and Pimote ORs the answers. One assertion of live work holds the session open.

With no responder, the base rule applies and an idle session is reaped.

## What counts as live work

That is your policy. Pimote learns only a boolean, and it never inspects what the work is. Answer `true` when closing the session now would lose work, and `false` when it would not.

## Server side

`askActivity(bus)` is the Pimote-side twin of the poll. It emits `pimote:activity:request`, reads every answer inline, and returns `true` when any responder claims work. It fails open: no responder means no background work.

Extensions do not call it. It ships in the SDK so the whole protocol lives in one module and tests can drive both ends.

## Exports

`answerActivity`, `askActivity`, and the type `ActivityMessage`.
