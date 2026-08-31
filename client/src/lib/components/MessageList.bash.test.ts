import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('MessageList native bash display boundary', () => {
  const source = readFileSync(resolve(__dirname, 'MessageList.svelte'), 'utf8');

  it('renders the dedicated bash presentation component for transient executions', () => {
    expect(source).toContain("import BashExecution from './BashExecution.svelte'");
    expect(source).toContain('bashExecutions');
    expect(source).toContain('<BashExecution');
  });

  it('keeps running bash entries in display order and wires cancellation independently', () => {
    expect(source).toContain('onCancel');
    expect(source).toContain("type: 'abort_bash'");
    expect(source).toContain('displayEntries');
  });
});
