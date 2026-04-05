export function statusRowSpacerClass(hasSessionDisplayName: boolean): string {
  return hasSessionDisplayName ? 'flex-1 md:hidden' : 'flex-1';
}
