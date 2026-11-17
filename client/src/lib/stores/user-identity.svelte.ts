// UserIdentityStore — the name this device sends as its connection identity.
//
// The transcript labels user rows with it, so the value must be reactive: one
// save in Settings updates every open transcript.

import { getUser, setUser } from './persistence.js';

/** Server-side fallback profile name, not a name the user chose. */
const DEFAULT_USER_NAME = 'default';

export class UserIdentityStore {
  /** Null until this device stores a name of its own. */
  name = $state<string | null>(getUser());

  /** The name to label this device's messages with, or null when unnamed. */
  get label(): string | null {
    const name = this.name?.trim();
    if (!name || name === DEFAULT_USER_NAME) return null;
    return name;
  }

  /** Store a name for this device and the next connection. */
  setName(value: string): void {
    setUser(value);
    this.name = getUser();
  }
}

export const userIdentity = new UserIdentityStore();
