/**
 * Shared shape for pimote extension tool results.
 *
 * Channel discipline follows pi's `AgentToolResult` contract — one audience
 * per channel:
 * - `content` — the model-facing text; the only channel the model sees.
 *   Data tools bound it with the spill guard (DR-071); their complete rows
 *   stay out of the model's context.
 * - `structuredContent` — the complete, outputSchema-valid payload for
 *   programmatic callers (codemode scripts resolve to it instead of the
 *   text). Never truncated.
 * - `details` — renderer/state metadata (pi: "for rendering or state
 *   reconstruction"), e.g. truncation facts. `undefined` when a tool has
 *   none. Never a copy of the payload.
 */

/** JSON value matching the SDK's `AgentToolResult.structuredContent` contract
 *  (mirrored locally; `JsonValue` is not re-exported by the SDK). */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { [key: string]: JsonValue };

/** A pimote tool result. Successful results set `isError` implicitly false. */
export interface JsonToolResult {
  content: [{ type: 'text'; text: string }];
  /** Present-but-`undefined` when the tool has no renderer metadata. */
  details: unknown;
  structuredContent: JsonValue;
  isError?: boolean;
}

/** A successful tool result carrying `payload` in full on the programmatic
 *  channels. `modelView` replaces the model-facing text when the spill guard
 *  bounds it (list tools); `details` carries renderer metadata when the tool
 *  has some. */
export function jsonToolResult<T>(payload: T, options: { modelView?: unknown; details?: unknown } = {}): JsonToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(options.modelView ?? payload) }],
    details: options.details,
    structuredContent: payload as unknown as JsonValue,
  };
}

/** A rejected-tool result: the error message as JSON payload plus the error
 *  flag, so the model reacts to the failure instead of treating it as data. */
export function errorToolResult(message: string): JsonToolResult {
  const payload = { error: message };
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], details: undefined, structuredContent: payload, isError: true };
}
