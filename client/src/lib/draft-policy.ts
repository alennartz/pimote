/**
 * Draft conflict resolution for fork input restoration.
 *
 * When a fork returns selectedText and the editor already has content,
 * the user chooses how to combine them. This module contains the pure
 * logic for that decision — extracted from MessageList orchestration
 * for testability.
 */

export type DraftChoice = 'replace' | 'append' | 'prepend' | 'ignore';

/**
 * Whether a fork with the given draft state needs a conflict prompt.
 * Returns true only when both currentDraft and selectedText are non-empty strings.
 */
export function needsDraftPrompt(_currentDraft: string, _selectedText: string | undefined): boolean {
  // Stub — implementation pending
  throw new Error('Not implemented: needsDraftPrompt');
}

/**
 * Compute the next editor text for a given draft choice.
 * Returns null for 'ignore' (draft remains unchanged).
 * For append/prepend, joins with a single newline separator.
 */
export function applyDraftChoice(_currentDraft: string, _selectedText: string, _choice: DraftChoice): string | null {
  // Stub — implementation pending
  throw new Error('Not implemented: applyDraftChoice');
}
