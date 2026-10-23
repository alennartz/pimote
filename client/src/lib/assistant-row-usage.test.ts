import { describe, expect, it } from 'vitest';
import type { PimoteAgentMessage, StreamingMessage } from '@pimote/shared';
import { summarizeAssistantRowUsage } from './assistant-row-usage.js';

type UsageFixture = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cacheWrite1h?: number;
  reasoning?: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
};

const usage = (
  cost: UsageFixture['cost'],
  tokens: Omit<UsageFixture, 'cost' | 'cacheWrite1h' | 'reasoning'> = {
    input: 10,
    output: 20,
    cacheRead: 30,
    cacheWrite: 40,
    totalTokens: 100,
  },
) => ({ ...tokens, cost });

const assistant = (content: PimoteAgentMessage['content'], messageUsage?: UsageFixture): PimoteAgentMessage =>
  ({ role: 'assistant', content, ...(messageUsage ? { usage: messageUsage } : {}) }) as PimoteAgentMessage;

const toolResult = (toolCallId: string, resultUsage?: UsageFixture): PimoteAgentMessage =>
  ({
    role: 'toolResult',
    content: [{ type: 'tool_result', toolCallId, toolName: 'nested', result: 'ok' }],
    ...(resultUsage ? { usage: resultUsage } : {}),
  }) as PimoteAgentMessage;

describe('summarizeAssistantRowUsage', () => {
  it('returns the assistant response usage as one row breakdown', () => {
    const message = assistant(
      [{ type: 'text', text: 'answer' }],
      usage({ input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 }, { input: 11, output: 22, cacheRead: 33, cacheWrite: 44, totalTokens: 110 }),
    );

    expect(summarizeAssistantRowUsage(message, [message])).toEqual({
      totalCostUsd: 1,
      breakdown: {
        tokens: { input: 11, output: 22, cacheRead: 33, cacheWrite: 44, total: 110 },
        cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4 },
      },
    });
  });

  it('adds usage from every tool result matching a tool call in this assistant row', () => {
    const message = assistant(
      [
        { type: 'text', text: 'answer' },
        { type: 'tool_call', toolCallId: 'tool-1', toolName: 'one' },
        { type: 'tool_call', toolCallId: 'tool-2', toolName: 'two' },
      ],
      usage({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 }, { input: 100, output: 200, cacheRead: 300, cacheWrite: 400, totalTokens: 1000 }),
    );
    const messages = [
      message,
      toolResult(
        'tool-1',
        usage({ input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 }, { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 100 }),
      ),
      toolResult(
        'tool-2',
        usage({ input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 }, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10 }),
      ),
      toolResult('other-tool', usage({ input: 9, output: 9, cacheRead: 9, cacheWrite: 9, total: 9 }, { input: 90, output: 90, cacheRead: 90, cacheWrite: 90, totalTokens: 90 })),
    ];

    expect(summarizeAssistantRowUsage(message, messages)).toEqual({
      totalCostUsd: 11.1,
      breakdown: {
        tokens: { input: 111, output: 222, cacheRead: 333, cacheWrite: 444, total: 1110 },
        cost: { input: 1.11, output: 2.22, cacheRead: 3.33, cacheWrite: 4.44 },
      },
    });
  });

  it('counts multiple matching tool results and ignores ordinary tool output without usage', () => {
    const message = assistant([{ type: 'tool_call', toolCallId: 'tool-1', toolName: 'one' }], usage({ input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 }));
    const nested = usage({ input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 });

    const result = summarizeAssistantRowUsage(message, [message, toolResult('tool-1', nested), toolResult('tool-1', nested), toolResult('tool-1')]);

    expect(result).toMatchObject({
      totalCostUsd: 1.2,
      breakdown: {
        tokens: { input: 30, output: 60, cacheRead: 90, cacheWrite: 120, total: 300 },
        cost: { input: 0.12, output: 0.24, cacheRead: 0.36, cacheWrite: 0.48 },
      },
    });
  });

  it('keeps each assistant response separate when the transcript has earlier rows', () => {
    const earlier = assistant([{ type: 'tool_call', toolCallId: 'earlier-tool', toolName: 'one' }], usage({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: 4 }));
    const current = assistant([{ type: 'tool_call', toolCallId: 'current-tool', toolName: 'two' }], usage({ input: 2, output: 2, cacheRead: 2, cacheWrite: 2, total: 8 }));
    const messages = [earlier, toolResult('earlier-tool', usage({ input: 3, output: 3, cacheRead: 3, cacheWrite: 3, total: 12 })), current];

    expect(summarizeAssistantRowUsage(current, messages)).toMatchObject({
      totalCostUsd: 8,
      breakdown: {
        tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, total: 100 },
        cost: { input: 2, output: 2, cacheRead: 2, cacheWrite: 2 },
      },
    });
  });

  it('accepts a streaming snapshot and does not add subset fields twice', () => {
    const streaming = {
      role: 'assistant',
      content: [{ type: 'text', text: 'partial' }],
      usage: usage({ input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 }, { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 100 }),
    } as unknown as StreamingMessage;

    expect(summarizeAssistantRowUsage(streaming, [])).toEqual({
      totalCostUsd: 1,
      breakdown: {
        tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, total: 100 },
        cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4 },
      },
    });
  });

  it('returns null when neither the assistant nor matching tool results have usage', () => {
    const message = assistant([{ type: 'text', text: 'no billing data' }]);

    expect(summarizeAssistantRowUsage(message, [message])).toBeNull();
  });
});
