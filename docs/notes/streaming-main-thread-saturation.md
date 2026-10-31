# Watch item: main-thread saturation during streaming

Source: branch-navigation work, commits `4008453` and `ba79ca6` (2026-10).

## What happened

Per-delta transcript maintenance saturated the main thread while a session
streamed. Measured on a 101-row transcript with 20 simulated deltas: **8,080
`getBoundingClientRect` row reads per burst against a necessary budget of 202**
(80× more than needed). Abort, jump navigation, and icon menus all felt broken.
One symptom — face menus appearing not to open while streaming — was pure jank:
the component logic was correct the whole time.

## Root cause pattern

Scroll, resize, and ResizeObserver notifications each triggered a synchronous
O(transcript-length) geometry scan. Work scaled with transcript size on every
streaming delta, not once per frame.

## Fix pattern (in `MessageList.svelte`)

Scroll/resize/observer notifications mark geometry dirty; a single
`requestAnimationFrame` callback performs one scan per frame and is cancelled on
destroy. After: 101 reads per burst, 1 per frame.

## What reviewers should watch for

- Per-delta or per-scroll handlers doing O(transcript) work: geometry reads,
  full-list rebuilds, DOM queries, markdown re-parses.
- Derived structures recomputed wholesale from one mutated field
  (a single streamed text block invalidating a whole-list derivation).
- Effects that read many reactive fields per delta and call `tick()`/scroll in
  response.
- "It feels dead while streaming" bug reports: suspect jank before hunting for
  logic bugs. Reproduce with a component test that counts work units per
  simulated delta batch (see `MessageList.streaming-layout.test.ts`) and set an
  explicit budget.

## Budget rule of thumb

One frame of streaming maintenance may touch each visible row once. Anything
that scales with `rows × deltas` per burst is a defect.
