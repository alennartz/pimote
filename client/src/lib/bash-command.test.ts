import { describe, expect, it } from 'vitest';
import { parseBangBashCommand } from './bash-command.js';

describe('parseBangBashCommand', () => {
  it('parses a single leading bang as a context-visible bash command', () => {
    expect(parseBangBashCommand("!printf 'hello\\n'")).toEqual({
      command: "printf 'hello\\n'",
      excludeFromContext: false,
    });
  });

  it('parses a double leading bang as a context-excluded bash command', () => {
    expect(parseBangBashCommand('!!git status --short')).toEqual({
      command: 'git status --short',
      excludeFromContext: true,
    });
  });

  it('trims only the input and command boundary around the bang prefix', () => {
    expect(parseBangBashCommand('  !!   printf "unchanged ; spacing"  ')).toEqual({
      command: 'printf "unchanged ; spacing"',
      excludeFromContext: true,
    });
  });

  it('returns null for ordinary prompts without a leading bang', () => {
    expect(parseBangBashCommand('please explain !important CSS')).toBeNull();
  });

  it('returns null for a bare bang with no command text', () => {
    expect(parseBangBashCommand('!')).toBeNull();
    expect(parseBangBashCommand('!!')).toBeNull();
    expect(parseBangBashCommand('   !!   ')).toBeNull();
  });
});
