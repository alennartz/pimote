export function isUpwardSessionPillSwipe(deltaX: number, deltaY: number): boolean {
  return deltaY < 0 && Math.abs(deltaY) > Math.abs(deltaX);
}

export function shouldOpenSessionPillActions(deltaX: number, deltaY: number, threshold = 16): boolean {
  return deltaY < -threshold && Math.abs(deltaY) > Math.abs(deltaX);
}
