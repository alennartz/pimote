export interface ExtensionDialogStateLike {
  method: string;
  placeholder?: string;
  prefill?: string;
}

export function getExtensionDialogInitialValue(current: ExtensionDialogStateLike | null): string {
  if (!current) return '';
  if (current.method === 'input') return '';
  if (current.method === 'editor') return current.prefill ?? '';
  return '';
}
