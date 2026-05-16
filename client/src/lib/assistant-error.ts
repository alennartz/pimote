export interface ParsedAssistantError {
  summary: string;
  detail?: string;
  requestId?: string;
}

export function parseAssistantError(raw: string): ParsedAssistantError {
  const fallback = raw.trim() || 'Unknown provider error';

  try {
    const parsed = JSON.parse(raw) as {
      error?: { message?: unknown; type?: unknown; details?: unknown };
      request_id?: unknown;
      message?: unknown;
      type?: unknown;
    };

    const nested = parsed.error;
    const message =
      typeof nested?.message === 'string' && nested.message.trim()
        ? nested.message.trim()
        : typeof parsed.message === 'string' && parsed.message.trim()
          ? parsed.message.trim()
          : fallback;
    const errorType =
      typeof nested?.type === 'string' && nested.type.trim() ? nested.type.trim() : typeof parsed.type === 'string' && parsed.type.trim() ? parsed.type.trim() : undefined;
    const requestId = typeof parsed.request_id === 'string' && parsed.request_id.trim() ? parsed.request_id.trim() : undefined;

    return {
      summary: errorType ? `${message} (${errorType})` : message,
      detail: fallback,
      ...(requestId ? { requestId } : {}),
    };
  } catch {
    return { summary: fallback };
  }
}
