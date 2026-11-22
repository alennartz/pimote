import type { LauncherSearchScope, SearchLauncherResponseData } from '@pimote/shared';
import { connection } from '../stores/connection.svelte.js';
import type { CreateLauncherSearchOptions, LauncherSearchController, LauncherSearchTransport, LauncherSnapshot, ParsedLauncherQuery } from './contracts.js';
import { filterLauncherCommands, parseLauncherQuery } from './query.js';

const DEFAULT_DEBOUNCE_MS = 120;
const DEFAULT_LIMIT = 10;

function emptySnapshot(): LauncherSnapshot {
  return {
    query: parseLauncherQuery(''),
    loading: false,
    error: null,
    folders: [],
    sessions: [],
    commands: [],
  };
}

export function createWsLauncherTransport(): LauncherSearchTransport {
  return {
    async search(params) {
      const response = await connection.send({
        type: 'search_launcher',
        query: params.query,
        scope: params.scope,
        limit: params.limit,
        ...(params.includeArchived !== undefined ? { includeArchived: params.includeArchived } : {}),
      });
      if (!response.success || !response.data) {
        throw new Error(response.error ?? 'Search failed');
      }
      const data = response.data as Partial<SearchLauncherResponseData>;
      if (!Array.isArray(data.folders) || !Array.isArray(data.sessions)) {
        throw new Error('Malformed search response');
      }
      return { folders: data.folders, sessions: data.sessions };
    },
  };
}

export function createLauncherSearch(options: CreateLauncherSearchOptions): LauncherSearchController {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const limit = options.limit ?? DEFAULT_LIMIT;
  let snapshot: LauncherSnapshot = emptySnapshot();
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function emit(next: LauncherSnapshot): void {
    snapshot = next;
    options.onChange?.(snapshot);
  }

  function cancelTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  async function runRemote(parsed: ParsedLauncherQuery, gen: number): Promise<void> {
    const scope: LauncherSearchScope = parsed.category === 'folders' || parsed.category === 'sessions' ? parsed.category : 'all';
    try {
      const data = await options.transport.search({
        query: parsed.term,
        scope,
        limit,
      });
      if (disposed || gen !== generation) return;
      emit({
        ...snapshot,
        loading: false,
        error: null,
        folders: scope === 'sessions' ? [] : data.folders,
        sessions: scope === 'folders' ? [] : data.sessions,
      });
    } catch (err) {
      if (disposed || gen !== generation) return;
      const message = err instanceof Error && err.message ? err.message : 'Search failed';
      emit({
        ...snapshot,
        loading: false,
        error: message,
      });
    }
  }

  function updateQuery(raw: string, immediate: boolean): void {
    if (disposed) return;
    cancelTimer();
    const gen = ++generation;
    const parsed = parseLauncherQuery(raw);
    const commands = parsed.category === 'all' || parsed.category === 'commands' ? filterLauncherCommands(options.getCommands(), parsed.term) : [];

    if (parsed.category === 'commands') {
      emit({
        query: parsed,
        loading: false,
        error: null,
        folders: [],
        sessions: [],
        commands,
      });
      return;
    }

    emit({
      query: parsed,
      loading: true,
      error: null,
      folders: parsed.category === 'sessions' ? [] : snapshot.folders,
      sessions: parsed.category === 'folders' ? [] : snapshot.sessions,
      commands,
    });

    if (immediate || debounceMs <= 0) {
      void runRemote(parsed, gen);
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      void runRemote(parsed, gen);
    }, debounceMs);
  }

  return {
    get snapshot() {
      return snapshot;
    },
    open() {
      updateQuery('', true);
    },
    setQuery(raw: string) {
      updateQuery(raw, false);
    },
    reset() {
      if (disposed) return;
      cancelTimer();
      generation += 1;
      emit(emptySnapshot());
    },
    dispose() {
      disposed = true;
      cancelTimer();
      generation += 1;
    },
  };
}
