import { describe, it, expect } from 'vitest';
import { getSessionChipLabel, SESSION_CHIP_BUDGET } from './session-summary.js';

describe('getSessionChipLabel', () => {
  it('shows a resolved name shorter than the budget as-is', () => {
    expect(getSessionChipLabel({ projectName: 'pimote', sessionName: 'Fix login', firstMessage: 'why does the socket drop after idle?' })).toBe('Fix login');
  });

  it('shows an explicit name up to the budget as-is', () => {
    expect(getSessionChipLabel({ projectName: 'pimote', sessionName: 'Fix login!!', firstMessage: 'why does the socket drop' })).toBe('Fix login!!');
    expect(getSessionChipLabel({ projectName: 'pimote', sessionName: 'Fix login!!!', firstMessage: 'why does the socket drop' })).toBe('Fix login!!!');
  });

  it('truncates a long explicit name instead of generating one from project and first message', () => {
    expect(
      getSessionChipLabel({
        projectName: 'pimote',
        sessionName: 'Investigate websocket flakiness',
        firstMessage: 'why does the socket drop after idle?',
      }),
    ).toBe('Investigate');
    expect(getSessionChipLabel({ projectName: 'pimote', extensionTitle: 'Investigate websocket flakiness' })).toBe('Investigate');
  });

  it('prefers extensionTitle over sessionName', () => {
    expect(getSessionChipLabel({ projectName: 'pimote', extensionTitle: 'Browser', sessionName: 'Fix login', firstMessage: 'why does the socket drop' })).toBe('Browser');
  });

  it('builds project name plus first-message prefix when there is no explicit name', () => {
    expect(getSessionChipLabel({ projectName: 'pimote', firstMessage: 'why does the socket drop after idle?' })).toBe('pimote-why d');
  });

  it('caps the constructed label at the budget', () => {
    const label = getSessionChipLabel({
      projectName: 'pimote',
      firstMessage: 'why does the socket drop after idle?',
    })!;
    expect(label.length).toBe(SESSION_CHIP_BUDGET);
  });

  it('uses the first message as the resolved name source when there is no explicit name', () => {
    expect(getSessionChipLabel({ projectName: 'pimote', firstMessage: 'why does the socket drop after idle?' })).toBe('pimote-why d');
    expect(getSessionChipLabel({ projectName: 'pimote', firstMessage: 'short' })).toBe('short');
  });

  it('trims a long project name to leave the message at least one character', () => {
    const label = getSessionChipLabel({
      projectName: 'my-awesome-project',
      firstMessage: 'why does the socket drop',
    })!;
    expect(label).toBe('my-awesome-w');
    expect(label.length).toBe(SESSION_CHIP_BUDGET);
  });

  it('falls back to the capped project name when there is no explicit name and no first message', () => {
    expect(getSessionChipLabel({ projectName: 'pimote' })).toBe('pimote');
    expect(getSessionChipLabel({ projectName: 'my-awesome-project' })).toBe('my-awesome-p');
  });

  it('falls back to the capped resolved name when there is no project name', () => {
    expect(getSessionChipLabel({ sessionName: 'Investigate websocket flakiness', firstMessage: 'why does the socket drop' })).toBe('Investigate');
  });

  it('returns null when there is nothing to show', () => {
    expect(getSessionChipLabel(null)).toBeNull();
    expect(getSessionChipLabel({})).toBeNull();
  });
});
