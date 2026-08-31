import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('InputBar native bang command boundary', () => {
  const source = readFileSync(resolve(__dirname, 'InputBar.svelte'), 'utf8');

  it('uses the shared leading-bang parser instead of sending ! text as a prompt', () => {
    expect(source).toContain('parseBangBashCommand');
    expect(source).toContain("type: 'bash'");
  });

  it('checks bang commands before the streaming steer branch', () => {
    const bangIndex = source.indexOf('parseBangBashCommand');
    const streamingIndex = source.indexOf('isStreaming');
    expect(bangIndex).toBeGreaterThanOrEqual(0);
    expect(streamingIndex).toBeGreaterThanOrEqual(0);
    expect(bangIndex).toBeLessThan(streamingIndex);
  });

  it('supplies a caller-owned request ID and preserves !! context exclusion', () => {
    expect(source).toContain('excludeFromContext');
    expect(source).toContain('crypto.randomUUID');
    expect(source).toContain('startBash');
  });
});
