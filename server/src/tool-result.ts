/**
 * Shared shape for pimote extension tool results.
 *
 * Every pimote tool reports the same idiom: the model-facing text is the JSON
 * serialization of the payload, the same payload rides as `details` (persisted
 * in the transcript, replayed to clients) and as `structuredContent`
 * (machine-readable, per the tool's declared `outputSchema` — codemode
 * scripts receive it instead of the text).
 */

/** JSON value matching the SDK's `AgentToolResult.structuredContent` contract
 *  (mirrored locally; `JsonValue` is not re-exported by the SDK). */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { [key: string]: JsonValue };

/** A pimote tool result: JSON text plus the payload as details and
 *  structured content. Successful results set `isError` implicitly false. */
export interface JsonToolResult<T> {
  content: [{ type: 'text'; text: string }];
  details: T;
  structuredContent: JsonValue;
  isError?: boolean;
}

/** A successful tool result carrying `payload`. */
export function jsonToolResult<T>(payload: T): JsonToolResult<T> {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], details: payload, structuredContent: payload as unknown as JsonValue };
}

/** A rejected-tool result: the error message as JSON payload plus the error
 *  flag, so the model reacts to the failure instead of treating it as data. */
export function errorToolResult(message: string): JsonToolResult<{ error: string }> {
  const payload = { error: message };
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], details: payload, structuredContent: payload, isError: true };
}
