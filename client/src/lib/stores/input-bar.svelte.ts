export const editorTextRequest = $state({ text: '', seq: 0 });

export function setEditorText(text: string) {
  editorTextRequest.text = text;
  editorTextRequest.seq++;
}
