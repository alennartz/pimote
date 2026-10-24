import { describe, expect, it } from 'vitest';
import { RAW_INTERPRETER_PROMPT, renderInterpreterPrompt } from './interpreter-prompt.js';

describe('renderInterpreterPrompt', () => {
  it('substitutes the configured worker model without changing the raw template', () => {
    const prompt = renderInterpreterPrompt({ workerModel: 'test/worker' });
    expect(prompt).toContain('model: "test/worker"');
    expect(prompt).not.toContain('{{workerModel}}');
    expect(RAW_INTERPRETER_PROMPT).toContain('{{workerModel}}');
  });

  it('states audio routing and acknowledgement order once within the voice prompt', () => {
    const prompt = renderInterpreterPrompt({ workerModel: 'test/worker' });
    expect(prompt.match(/free-text assistant output/g)).toHaveLength(1);
    expect(prompt.match(/Before other tools, call `speak`/g)).toHaveLength(1);
    expect(prompt).toContain('During this call, use `speak` for audible replies');
    expect(prompt).toContain('Keep the acknowledgement and work in the same response');
    expect(prompt).not.toContain('Do not start a turn with a tool call');
  });

  it('uses one consistent speech-length rule', () => {
    const prompt = renderInterpreterPrompt({ workerModel: 'test/worker' });
    expect(prompt.match(/one or two short sentences per call/g)).toHaveLength(1);
    expect(prompt).not.toMatch(/1[–-]3|one (?:or|to) three/);
    expect(prompt).toContain('For longer updates, split the speech across calls in the same response.');
    expect(prompt).toContain('Describe code, paths, and long identifiers instead of reading them aloud.');
  });

  it('greets the user and waits before dispatching a worker task', () => {
    const prompt = renderInterpreterPrompt({ workerModel: 'test/worker' });
    expect(prompt).toContain('<voice_call_started/>');
    expect(prompt).toContain('Greet the user proactively, then end your turn so the user can reply.');
    expect(prompt).toContain("Wait for the user's reply before dispatching any worker task.");
  });

  it('retains the configured long-lived worker and forwards decisions through the user', () => {
    const prompt = renderInterpreterPrompt({ workerModel: 'test/worker' });
    expect(prompt).toContain('For software-engineering tasks, spawn a worker with the `my-pi` `subagent` tool.');
    expect(prompt).toContain('The worker is long-lived. Spawn it once when first needed.');
    expect(prompt).toContain('When the worker goes idle, keep it alive.');
    expect(prompt).toContain('For subsequent tasks, use `send` to dispatch new work to the existing worker.');
    expect(prompt).toContain('Only tear it down at the end of the call or when it is clearly broken.');
    expect(prompt).toContain('When spawning the worker, always pass `model: "test/worker"`');
    expect(prompt).toContain("Wait for the user's answer before forwarding it to the worker.");
    expect(prompt).toContain('For conversational turns, use `speak` alone without a worker.');
  });
});
