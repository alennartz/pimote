package com.pimote.android.util

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.runningFold

/**
 * Emit each (previous, current) pair from the source flow. The first emission
 * has `previous == null`. Carries the previous emission immutably inside the
 * pipeline so collectors don't need to capture a `var prev` across coroutine
 * resumptions — which is banned by the principles in `~/.pi/agent/AGENTS.md`
 * (no mutable captures in lambdas).
 *
 * Use this when you need to react to a transition rather than a value (the
 * "edge" — e.g. false→true, Idle→non-Idle). Pair with [onEdge] when you only
 * want emissions where the transition matches a predicate.
 */
fun <T> Flow<T>.withPrevious(): Flow<Pair<T?, T>> =
    runningFold<T, Pair<T?, T>?>(null) { acc, cur -> (acc?.second) to cur }
        .filter { it != null }
        .map { it!! }

/**
 * Emit `Unit` each time the (previous, current) pair satisfies [predicate].
 * Shorthand for `withPrevious().filter(predicate).map {}`. The first emission
 * is fed `previous == null` so initial-state edges (e.g. "first time we see
 * Connected") are detectable.
 */
fun <T> Flow<T>.onEdge(predicate: (previous: T?, current: T) -> Boolean): Flow<Unit> =
    withPrevious()
        .filter { (prev, cur) -> predicate(prev, cur) }
        .map { }
