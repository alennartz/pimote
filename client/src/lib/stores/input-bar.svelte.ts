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

/** Consume the pending Web Share payload once a composer is eligible to receive it. */
export function consumeSharedImages(): string[] {
  if (sharedImagesRequest.images.length === 0) return [];
  const images = [...sharedImagesRequest.images];
  sharedImagesRequest.images = [];
  return images;
}
