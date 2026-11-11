<script lang="ts">
  import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuGroupHeading,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    DropdownMenuLabel,
  } from '$lib/components/ui/dropdown-menu/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Check from '@lucide/svelte/icons/check';
  import { SvelteMap } from 'svelte/reactivity';
  import Loader2 from '@lucide/svelte/icons/loader-2';
  import { untrack } from 'svelte';
  import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
  import { fuzzyFilter } from '$lib/fuzzy.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import type { SessionMeta } from '@pimote/shared';

  interface AvailableModel {
    provider: string;
    id: string;
    name: string;
  }

  let models: AvailableModel[] = $state([]);
  let loading = $state(false);
  let open = $state(false);
  let filterQuery = $state('');
  let searchInput: HTMLInputElement | null = $state(null);
  let contentElement: HTMLDivElement | null = $state(null);

  let filteredModels = $derived(fuzzyFilter(models, filterQuery, (model) => `${model.provider}/${model.name} ${model.id}`));
  let child = $derived(sessionRegistry.viewedSubagentAttachment);
  let rootSessionId = $derived(sessionRegistry.viewedSessionId);
  let activeModel = $derived(child?.state.model ?? sessionRegistry.viewed?.model);

  function activePath(): import('@pimote/shared').AgentPath | null {
    return rootSessionId ? (sessionRegistry.getSelectedSubagentPath?.(rootSessionId) ?? null) : null;
  }

  function sendSurface(command: Record<string, unknown>): Promise<import('@pimote/shared').PimoteResponse> {
    const rootId = rootSessionId;
    const path = activePath();
    if (!rootId || (child && !path)) return Promise.reject(new Error('No session surface is open'));
    return sessionRegistry.sendSurfaceCommand(rootId, child ? path : null, command);
  }

  // Group filtered models by provider.
  let grouped = $derived.by(() => {
    const map = new SvelteMap<string, AvailableModel[]>();
    for (const m of filteredModels) {
      const list = map.get(m.provider) ?? [];
      list.push(m);
      map.set(m.provider, list);
    }
    return map;
  });

  // Fetch models when dropdown opens
  $effect(() => {
    if (open) {
      filterQuery = '';
      untrack(() => fetchModels());
    }
  });

  function handleOpenAutoFocus(event: Event) {
    event.preventDefault();
    requestAnimationFrame(() => {
      if (typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches) {
        searchInput?.focus();
      } else {
        contentElement?.focus();
      }
    });
  }

  function handleSearchKeydown(event: KeyboardEvent) {
    // Keep editing keys in the search field. Navigation/selection keys bubble
    // to the dropdown menu so its built-in roving focus and Enter selection work.
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Tab', 'Escape', 'Enter'].includes(event.key)) return;
    event.stopPropagation();
  }

  async function fetchModels() {
    if (loading) return;
    loading = true;
    try {
      if (!rootSessionId || (child && !activePath())) {
        loading = false;
        return;
      }
      const res = await sendSurface({ type: 'get_available_models' });
      if (res.success && res.data) {
        const arr = (res.data as { models?: unknown }).models;
        if (Array.isArray(arr)) {
          models = arr as AvailableModel[];
        }
      }
    } catch {
      // ignore — models stay empty
    } finally {
      loading = false;
    }
  }

  async function selectModel(model: AvailableModel) {
    if (!rootSessionId || (child && !activePath())) return;
    const res = await sendSurface({
      type: 'set_model',
      provider: model.provider,
      modelId: model.id,
    });
    if (res.success && res.data) {
      const state = res.data as {
        model: { provider: string; id: string; name: string } | null;
        thinkingLevel: string;
        availableThinkingLevels: string[];
      };
      if (!child) {
        const session = sessionRegistry.sessions[rootSessionId];
        if (session) {
          session.model = state.model ?? { provider: model.provider, id: model.id, name: model.name };
          session.thinkingLevel = state.thinkingLevel;
          session.availableThinkingLevels = state.availableThinkingLevels;
        }
      } else {
        child.state = {
          ...child.state,
          model: state.model ?? { provider: model.provider, id: model.id, name: model.name },
          thinkingLevel: state.thinkingLevel,
          availableThinkingLevels: state.availableThinkingLevels,
        };
      }
      const metaRes = await sendSurface({ type: 'get_session_meta' });
      if (!child && metaRes.success && metaRes.data) sessionRegistry.updateMeta(rootSessionId, (metaRes.data as { meta: SessionMeta }).meta);
    }
    open = false;
  }

  function isSelected(model: AvailableModel): boolean {
    return activeModel?.provider === model.provider && activeModel?.id === model.id;
  }
</script>

<DropdownMenu bind:open>
  <DropdownMenuTrigger>
    <Button
      variant="ghost"
      size="xs"
      class="text-muted-foreground max-w-48 gap-1 truncate"
      title={activeModel ? `${activeModel.provider}/${activeModel.name}` : 'No model selected'}
    >
      <span class="truncate text-xs">
        {activeModel?.name ?? 'No model'}
      </span>
      <ChevronDown class="size-3 shrink-0" />
    </Button>
  </DropdownMenuTrigger>
  <DropdownMenuContent
    bind:ref={contentElement}
    align="start"
    onOpenAutoFocus={handleOpenAutoFocus}
    class="max-h-72 w-max max-w-[min(28rem,calc(100vw-1rem))] min-w-52 overflow-y-auto"
  >
    <DropdownMenuLabel>Models</DropdownMenuLabel>
    <div class="px-1 pb-1">
      <Input bind:ref={searchInput} bind:value={filterQuery} aria-label="Filter models" placeholder="Filter models…" class="h-8 text-sm" onkeydown={handleSearchKeydown} />
    </div>
    <DropdownMenuSeparator />
    {#if loading && models.length === 0}
      <div class="flex items-center justify-center py-4">
        <Loader2 class="text-muted-foreground size-4 animate-spin" />
      </div>
    {:else if models.length === 0}
      <div class="text-muted-foreground px-2 py-4 text-center text-xs">No models available</div>
    {:else if filteredModels.length === 0}
      <div class="text-muted-foreground px-2 py-4 text-center text-xs">No matching models</div>
    {:else}
      {#each [...grouped.entries()] as [provider, providerModels], i (provider)}
        {#if i > 0}
          <DropdownMenuSeparator />
        {/if}
        <DropdownMenuGroup>
          <DropdownMenuGroupHeading>{provider}</DropdownMenuGroupHeading>
          {#each providerModels as model (model.id)}
            <DropdownMenuItem onclick={() => selectModel(model)} class="flex items-center justify-between gap-2">
              <span class="min-w-0 break-words">{model.name}</span>
              {#if isSelected(model)}
                <Check class="text-primary size-3.5 shrink-0" />
              {/if}
            </DropdownMenuItem>
          {/each}
        </DropdownMenuGroup>
      {/each}
    {/if}
  </DropdownMenuContent>
</DropdownMenu>
