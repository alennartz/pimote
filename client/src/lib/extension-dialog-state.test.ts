import { describe, expect, it } from 'vitest';
import { getExtensionDialogInitialValue } from './extension-dialog-state.js';

describe('getExtensionDialogInitialValue', () => {
  it('returns empty string for input dialogs even when a placeholder exists', () => {
    expect(
      getExtensionDialogInitialValue({
        method: 'input',
        placeholder: 'Type something...',
      }),
    ).toBe('');
  });

  it('returns prefill for editor dialogs', () => {
    expect(
      getExtensionDialogInitialValue({
        method: 'editor',
        prefill: 'function greet() {}',
      }),
    ).toBe('function greet() {}');
  });

  it('returns empty string for editor dialogs without prefill', () => {
    expect(getExtensionDialogInitialValue({ method: 'editor' })).toBe('');
  });

  it('returns empty string when there is no current dialog', () => {
    expect(getExtensionDialogInitialValue(null)).toBe('');
  });
});
