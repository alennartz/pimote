import { describe, it, expect } from 'vitest';
import { formatSessionCost, formatCombinedCost, getSessionChipLabel, SESSION_CHIP_BUDGET } from './session-summary.js';

describe('formatSessionCost', () => {
  describe('no-spend sentinel', () => {
    it('returns null for exactly 0', () => {
      expect(formatSessionCost(0)).toBeNull();
    });

    it('returns null for a negative value (should not occur)', () => {
      expect(formatSessionCost(-1.5)).toBeNull();
    });
  });

  describe('sub-cent spend', () => {
    it('renders "<$0.01" for a value between 0 and one cent', () => {
      expect(formatSessionCost(0.004)).toBe('<$0.01');
    });

    it('renders "<$0.01" for a very small positive value', () => {
      expect(formatSessionCost(0.0001)).toBe('<$0.01');
    });
  });

  describe('cent-and-above spend', () => {
    it('renders exactly one cent as "$0.01"', () => {
      expect(formatSessionCost(0.01)).toBe('$0.01');
    });

    it('renders a few cents with two decimal places', () => {
      expect(formatSessionCost(0.04)).toBe('$0.04');
    });

    it('renders dollars-and-cents with two decimal places', () => {
      expect(formatSessionCost(1.23)).toBe('$1.23');
    });

    it('rounds to two decimal places', () => {
      // Rounding mode is the implementer's call; toFixed(2) rounds half up here.
      expect(formatSessionCost(1.235)).toBe('$1.24');
    });

    it('pads whole-dollar amounts to two decimal places', () => {
      expect(formatSessionCost(12)).toBe('$12.00');
    });
  });
});

describe('formatCombinedCost', () => {
  it('returns null when there is no lifetime cost to show', () => {
    expect(formatCombinedCost(0, 0.03)).toBeNull();
    expect(formatCombinedCost(0, null)).toBeNull();
  });

  it('returns the base cost alone when there is no next-round-trip figure', () => {
    expect(formatCombinedCost(1.23, null)).toBe('$1.23');
    expect(formatCombinedCost(1.23, 0)).toBe('$1.23');
    expect(formatCombinedCost(1.23, undefined)).toBe('$1.23');
  });

  it('appends the next-round-trip lower bound in parentheses', () => {
    expect(formatCombinedCost(1.23, 0.03)).toBe('$1.23 (+$0.03)');
  });

  it('renders a sub-cent increment as "+<$0.01"', () => {
    expect(formatCombinedCost(1.23, 0.004)).toBe('$1.23 (+<$0.01)');
  });
});

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
