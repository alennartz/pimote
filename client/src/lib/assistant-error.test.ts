import { describe, expect, it } from 'vitest';
import { parseAssistantError } from './assistant-error.js';

describe('parseAssistantError', () => {
  it('extracts a readable summary from provider JSON', () => {
    expect(parseAssistantError('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_123"}')).toEqual({
      summary: 'Overloaded (overloaded_error)',
      detail: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_123"}',
      requestId: 'req_123',
    });
  });

  it('falls back to the raw error string when the payload is not JSON', () => {
    expect(parseAssistantError('socket closed')).toEqual({ summary: 'socket closed' });
  });

  it('uses a default message when the raw payload is empty', () => {
    expect(parseAssistantError('   ')).toEqual({ summary: 'Unknown provider error' });
  });
});
