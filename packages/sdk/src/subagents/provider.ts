import type { ExtensionAPI, EventBus } from '@earendil-works/pi-coding-agent';
import type { SubagentEventBusOwner, SubagentProvider, SubagentProviderDiscovery, SubagentProviderRequest, SubagentProviderResponse } from './types.js';

/** EventBus channel emitted by a Pimote host to discover a provider. */
export const SUBAGENT_PROVIDER_REQUEST = 'pimote:subagents:request' as const;
/** EventBus channel carrying the currently registered provider. */
export const SUBAGENT_PROVIDER_RESPONSE = 'pimote:subagents:response' as const;

/**
 * Narrow an ExtensionAPI/EventBus-like value to its EventBus.
 *
 * The SDK keeps this adapter structural so extensions can use the same seam in
 * tests without constructing a complete ExtensionAPI object.
 */
function eventBusOf(owner: SubagentEventBusOwner | ExtensionAPI): Pick<EventBus, 'on' | 'emit'> {
  if ('events' in owner) return owner.events;
  return owner;
}

function providerFrom(data: unknown): SubagentProvider | undefined {
  if (data && typeof data === 'object' && 'provider' in data) {
    const provider = (data as { provider?: unknown }).provider;
    return provider && typeof provider === 'object' ? (provider as SubagentProvider) : undefined;
  }
  return data && typeof data === 'object' ? (data as SubagentProvider) : undefined;
}

function response(provider: SubagentProvider): SubagentProviderResponse {
  return { provider };
}

interface Registration {
  active: boolean;
  unsubscribeRequest: () => void;
}

/**
 * One provider registration per session EventBus.
 *
 * Registration is a live responder rather than a one-shot value. A host can
 * begin discovery before the extension binds, and a later registration or
 * replacement is delivered immediately. Calling this again on the same bus
 * deactivates the previous responder. The function never owns or disposes the
 * provider; the owner controls its lifecycle.
 */
const registrations = new WeakMap<object, Registration>();

export function registerProvider(owner: SubagentEventBusOwner | ExtensionAPI, provider: SubagentProvider): () => void {
  const bus = eventBusOf(owner);
  const key = bus as object;
  const previous = registrations.get(key);
  previous?.unsubscribeRequest();
  if (previous) previous.active = false;

  const registration: Registration = {
    active: true,
    unsubscribeRequest: () => undefined,
  };
  registration.unsubscribeRequest = bus.on(SUBAGENT_PROVIDER_REQUEST, () => {
    if (!registration.active) return;
    bus.emit(SUBAGENT_PROVIDER_RESPONSE, response(provider));
  });
  registrations.set(key, registration);

  // Hosts that already started discovery receive a replacement without a
  // second request. Hosts that have not started simply have this value ignored.
  bus.emit(SUBAGENT_PROVIDER_RESPONSE, response(provider));

  return () => {
    if (!registration.active) return;
    registration.active = false;
    registration.unsubscribeRequest();
    if (registrations.get(key) === registration) registrations.delete(key);
  };
}

export interface DiscoverProviderOptions {
  /** Called whenever the provider first appears or is replaced. */
  onProvider?: (provider: SubagentProvider) => void;
}

/**
 * Discover the provider on a session EventBus and keep listening for late
 * registration or replacement.
 *
 * With a callback, the return value is an unsubscribe function. Without a
 * callback, the return value is a discovery handle whose `provider` getter
 * reflects the latest registration. In both forms discovery emits one request
 * after installing its response listener, so a provider registered before or
 * during the handshake cannot be missed.
 */
export function discoverProvider(owner: SubagentEventBusOwner | ExtensionAPI, onProvider: (provider: SubagentProvider) => void): () => void;
export function discoverProvider(owner: SubagentEventBusOwner | ExtensionAPI, options?: DiscoverProviderOptions): SubagentProviderDiscovery;
export function discoverProvider(
  owner: SubagentEventBusOwner | ExtensionAPI,
  callbackOrOptions?: ((provider: SubagentProvider) => void) | DiscoverProviderOptions,
): (() => void) | SubagentProviderDiscovery {
  const bus = eventBusOf(owner);
  let current: SubagentProvider | undefined;
  let closed = false;
  const listeners = new Set<(provider: SubagentProvider | undefined) => void>();
  const callback = typeof callbackOrOptions === 'function' ? callbackOrOptions : callbackOrOptions?.onProvider;
  if (callback)
    listeners.add((provider) => {
      if (provider) callback(provider);
    });

  const publish = (provider: SubagentProvider | undefined) => {
    if (closed || provider === current) return;
    current = provider;
    for (const listener of [...listeners]) listener(provider);
  };
  const unsubscribeResponse = bus.on(SUBAGENT_PROVIDER_RESPONSE, (data) => publish(providerFrom(data)));
  bus.emit(SUBAGENT_PROVIDER_REQUEST, {} satisfies SubagentProviderRequest);

  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribeResponse();
    listeners.clear();
  };

  if (callback) return close;
  return {
    get provider() {
      return current;
    },
    get current() {
      return current;
    },
    subscribe(listener) {
      if (closed) return () => undefined;
      listeners.add(listener);
      if (current) listener(current);
      return () => listeners.delete(listener);
    },
    onProvider(listener) {
      if (closed) return () => undefined;
      listeners.add(listener);
      if (current) listener(current);
      return () => listeners.delete(listener);
    },
    close,
  };
}

/** Short alias for hosts that use the request/response verb. */
export const discover = discoverProvider;
/** Short alias for extensions that use the registration verb. */
export const register = registerProvider;
