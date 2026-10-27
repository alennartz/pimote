import { describe, expect, it } from 'vitest';
import { createBashCommandStreamer, extractBashCommand, type BashArgs } from './bash-content.js';

describe('extractBashCommand', () => {
  it('returns the command string from finalized args', () => {
    const args: BashArgs = { command: 'printf "hello\\n"' };
    expect(extractBashCommand(args)).toBe(args.command);
  });

  it('returns an empty string when command is missing or invalid', () => {
    expect(extractBashCommand({})).toBe('');
    expect(extractBashCommand({ command: 42 })).toBe('');
    expect(extractBashCommand(null)).toBe('');
    expect(extractBashCommand(undefined)).toBe('');
  });
});

describe('createBashCommandStreamer', () => {
  it('extracts a complete command from JSON', () => {
    const args: BashArgs = { command: 'git status --short' };
    const streamer = createBashCommandStreamer();
    streamer.write(JSON.stringify(args));

    expect(streamer.command).toBe(args.command);
    streamer.dispose();
  });

  it('reveals a command progressively when JSON arrives one character at a time', () => {
    const args: BashArgs = { command: 'printf "hello\\n"' };
    const streamer = createBashCommandStreamer();
    const snapshots: string[] = [];

    for (const character of JSON.stringify(args)) {
      streamer.write(character);
      snapshots.push(streamer.command);
    }

    expect(snapshots.some((value) => value.length > 0 && value.length < args.command.length)).toBe(true);
    expect(streamer.command).toBe(args.command);
    streamer.dispose();
  });

  it('preserves command text and ignores malformed input without throwing', () => {
    const streamer = createBashCommandStreamer();
    expect(() => {
      streamer.write('{"command":"echo hi');
      streamer.write('!!! not valid json !!!');
    }).not.toThrow();
    streamer.dispose();
  });
});
