export const editorTextRequest = $state({ sessionId: '', text: '', seq: 0 });

export function setEditorText(sessionId: string, text: string) {
  editorTextRequest.sessionId = sessionId;
  editorTextRequest.text = text;
  editorTextRequest.seq++;
}

// Shared images from Web Share Target API
export const sharedImagesRequest = $state({ images: [] as string[], seq: 0 });

export function pushSharedImages(images: string[]) {
  if (images.length === 0) return;
  sharedImagesRequest.images = images;
  sharedImagesRequest.seq++;
}
