/**
 * Boot-time garbage collection of the per-session static-host persistence dir.
 *
 * The common session JSON store owns the filesystem sweep; this feature keeps
 * the historical `gcStaticHostStore` name as its public adapter contract.
 */
export { gcSessionJsonStore as gcStaticHostStore } from '../session-json-store.js';
