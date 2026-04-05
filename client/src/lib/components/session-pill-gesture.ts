export function shouldOpenSessionPillActions(deltaX: number, deltaY: number, threshold = 16): boolean {
  return deltaY < -threshold && Math.abs(deltaY) > Math.abs(deltaX);
}
