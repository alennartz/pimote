import type { ExtensionAPI, EventBus } from '@earendil-works/pi-coding-agent';
import type { SubagentEventBusOwner, SubagentProviderDiscovery, SubagentProviderResponse } from './types.js';
import type { SubagentPresentationProvider } from './presentation.js';

/** EventBus channel a host emits to ask for the current provider. */
export const SUBAGENT_PROVIDER_REQUEST = 'pimote:subagents:request' as const;
/** EventBus channel carrying the current provider, or `undefined` after removal. */
export const SUBAGENT_PROVIDER_RESPONSE = 'pimote:subagents:response' as const;

function eventBusOf(owner: SubagentEventBusOwner | ExtensionAPI): Pick<EventBus, 'on' | 'emit'> {
  return 'events' in owner ? owner.events : owner;
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

/** The provider crosses the bus as a live object. Its contract is enforced
 *  where it was registered, so the guard checks its members' presence only. */
function isProvider(value: unknown): value is SubagentPresentationProvider {
  return isObject(value) && 'snapshot' in value && 'subscribe' in value && 'presenters' in value && 'acquire' in value;
}

/** Narrow a bus payload. A payload without a `provider` key is not a response. */
function responseFrom(data: unknown): { provider: SubagentPresentationProvider | undefined } | undefined {
  if (!isObject(data) || !('provider' in data)) {
    return undefined;
  }
  const provider = data.provider;
  if (provider === undefined) {
    return { provider: undefined };
  }
  return isProvider(provider) ? { provider } : undefined;
}

/**
 * Publish one provider on a session EventBus.
 *
 * The registration answers discovery requests until the returned function
 * runs. That function stops answering and publishes `{ provider: undefined }`,
 * so hosts learn that the provider went away. It never disposes the provider.
 * One owner registers at most one provider per bus; unregister before
 * registering a replacement.
 */
export function registerProvider(owner: SubagentEventBusOwner | ExtensionAPI, provider: SubagentPresentationProvider): () => void {
  const bus = eventBusOf(owner);
  let active = true;
  const response = (): SubagentProviderResponse => ({ provider });
  const unsubscribe = bus.on(SUBAGENT_PROVIDER_REQUEST, () => {
    if (active) {
      bus.emit(SUBAGENT_PROVIDER_RESPONSE, response());
    }
  });
  bus.emit(SUBAGENT_PROVIDER_RESPONSE, response());
  return () => {
    if (!active) {
      return;
    }
    active = false;
    unsubscribe();
    bus.emit(SUBAGENT_PROVIDER_RESPONSE, { provider: undefined } satisfies SubagentProviderResponse);
  };
}

/**
 * Track the provider on a session EventBus: the current one, every later
 * registration or replacement, and removal. Discovery installs its listener
 * before it asks, so a provider registered earlier cannot be missed.
 */
export function discoverProvider(owner: SubagentEventBusOwner | ExtensionAPI): SubagentProviderDiscovery {
  const bus = eventBusOf(owner);
  let current: SubagentPresentationProvider | undefined;
  let closed = false;
  const listeners = new Set<(provider: SubagentPresentationProvider | undefined) => void>();

  const publish = (provider: SubagentPresentationProvider | undefined): void => {
    if (closed || provider === current) {
      return;
    }
    current = provider;
    for (const listener of Array.from(listeners)) {
      listener(provider);
    }
  };
  const unsubscribe = bus.on(SUBAGENT_PROVIDER_RESPONSE, (data) => {
    const response = responseFrom(data);
    if (response) {
      publish(response.provider);
    }
  });
  bus.emit(SUBAGENT_PROVIDER_REQUEST, {});

  return {
    get provider() {
      return current;
    },
    subscribe(listener) {
      if (closed) {
        return () => undefined;
      }
      listeners.add(listener);
      if (current) {
        listener(current);
      }
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      unsubscribe();
      listeners.clear();
    },
  };
}
