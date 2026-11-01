import { describe, expect, it } from 'vitest';
import type { PimoteMessageContent } from '@pimote/shared';
import { collapseDuplicateTextBlocks } from './assistant-text-dedupe.js';

function text(t: string): PimoteMessageContent {
  return { type: 'text', text: t };
}

function thinking(t: string): PimoteMessageContent {
  return { type: 'thinking', text: t };
}

describe('collapseDuplicateTextBlocks', () => {
  it('collapses consecutive identical text blocks to one', () => {
    const content = [text('Hello world'), text('Hello world')];
    expect(collapseDuplicateTextBlocks(content)).toEqual([text('Hello world')]);
  });

  it('collapses a duplicate that follows a thinking block', () => {
    const content = [text('Answer'), thinking('reasoning'), text('Answer')];
    expect(collapseDuplicateTextBlocks(content)).toEqual([text('Answer'), thinking('reasoning')]);
  });

  it('collapses runs of identical blocks to one', () => {
    const content = [text('Same'), text('Same'), text('Same')];
    expect(collapseDuplicateTextBlocks(content)).toEqual([text('Same')]);
  });

  it('keeps blocks with different text', () => {
    const content = [text('First'), text('Second')];
    expect(collapseDuplicateTextBlocks(content)).toEqual(content);
  });

  it('keeps a repeat that follows a different block', () => {
    const content = [text('A'), text('B'), text('A')];
    expect(collapseDuplicateTextBlocks(content)).toEqual(content);
  });

  it('ignores surrounding whitespace when comparing', () => {
    const content = [text('Answer'), text('  Answer  ')];
    expect(collapseDuplicateTextBlocks(content)).toEqual([text('Answer')]);
  });

  it('passes through whitespace-only and empty text blocks', () => {
    const content = [text('  '), text(''), text('Answer')];
    expect(collapseDuplicateTextBlocks(content)).toEqual(content);
  });

  it('does not reset the match on whitespace-only blocks', () => {
    const content = [text('Answer'), text(' '), text('Answer')];
    expect(collapseDuplicateTextBlocks(content)).toEqual([text('Answer'), text(' ')]);
  });

  it('passes non-text blocks through unchanged', () => {
    const toolCall: PimoteMessageContent = { type: 'tool_call', toolCallId: 't1', toolName: 'read', args: {} };
    const content = [toolCall, thinking('hmm')];
    expect(collapseDuplicateTextBlocks(content)).toEqual(content);
  });

  it('keeps the original block objects for kept content', () => {
    const first = text('Hello');
    const content = [first, text('Hello')];
    expect(collapseDuplicateTextBlocks(content)[0]).toBe(first);
  });
});
