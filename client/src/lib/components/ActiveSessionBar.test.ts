import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ActiveSessionBar mobile action tray styling', () => {
  it('does not use hover-only classes for the Archive and Close tray buttons', () => {
    const source = readFileSync(resolve(__dirname, 'ActiveSessionBar.svelte'), 'utf8');

    expect(source).toContain('class="active:bg-accent active:text-accent-foreground flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium"');
    expect(source).toContain('class="text-destructive active:bg-destructive/10 flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium"');

    expect(source).not.toContain('hover:bg-accent hover:text-accent-foreground flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium');
    expect(source).not.toContain('text-destructive hover:bg-destructive/10 flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium');
  });
});
