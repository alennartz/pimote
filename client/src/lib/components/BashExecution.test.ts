import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('BashExecution presentation contract', () => {
  const source = readFileSync(resolve(__dirname, 'BashExecution.svelte'), 'utf8');

  it('renders the command with a shell prompt and keeps it visually separate from chat messages', () => {
    expect(source).toContain('$ ');
    expect(source).toContain('bash-execution');
    expect(source).toContain('bash-mode');
  });

  it('exposes running, completed, cancelled, nonzero, and truncation status affordances', () => {
    expect(source).toContain('running');
    expect(source).toContain('complete');
    expect(source).toContain('cancelled');
    expect(source).toContain('exitCode');
    expect(source).toContain('truncated');
  });

  it('provides a bounded collapsed output preview and an item-level cancel action', () => {
    expect(source).toContain('Show more');
    expect(source).toContain('Show less');
    expect(source).toContain('onCancel');
    expect(source).toContain('Cancel');
  });

  it('distinguishes normal context-visible commands from dimmed !! commands', () => {
    expect(source).toContain('excludeFromContext');
    expect(source).toContain('bash-excluded');
  });
});
