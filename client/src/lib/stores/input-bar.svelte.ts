export const editorTextRequest = $state({ sessionId: '', text: '', seq: 0 });

export function setEditorText(sessionId: string, text: string) {
  editorTextRequest.sessionId = sessionId;
  editorTextRequest.text = text;
  editorTextRequest.seq++;
}
