/** Global open state for the keyboard shortcuts cheat sheet. Lives in a
 *  .svelte.ts file so the `$state` field is reactive for Svelte 5. */
class ShortcutHelpStore {
  isOpen: boolean = $state(false);

  open(): void {
    this.isOpen = true;
  }

  close(): void {
    this.isOpen = false;
  }
}

export const shortcutHelpStore = new ShortcutHelpStore();
