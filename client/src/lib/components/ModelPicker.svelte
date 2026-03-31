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
  import { connection } from '$lib/stores/connection.svelte.js';

  interface AvailableModel {
    provider: string;
    id: string;
    name: string;
  }

  let models: AvailableModel[] = $state([]);
  let loading = $state(false);
  let open = $state(false);

  // Group models by provider
  let grouped = $derived.by(() => {
    const map = new SvelteMap<string, AvailableModel[]>();
    for (const m of models) {
      const list = map.get(m.provider) ?? [];
      list.push(m);
      map.set(m.provider, list);
    }
    return map;
  });

  // Fetch models when dropdown opens
  $effect(() => {
    if (open) {
      untrack(() => fetchModels());
    }
  });

  async function fetchModels() {
    if (loading) return;
    loading = true;
    try {
      const sessionId = sessionRegistry.viewed?.sessionId;
      if (!sessionId) {
        loading = false;
        return;
      }
      const res = await connection.send({ type: 'get_available_models', sessionId });
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
    const sessionId = sessionRegistry.viewed?.sessionId;
    if (!sessionId) return;
    const res = await connection.send({
      type: 'set_model',
      sessionId,
      provider: model.provider,
      modelId: model.id,
    });
    if (res.success) {
      const session = sessionRegistry.sessions[sessionId];
      if (session) {
        session.model = { provider: model.provider, id: model.id, name: model.name };
      }
    }
    open = false;
  }

  function isSelected(model: AvailableModel): boolean {
    return sessionRegistry.viewed?.model?.provider === model.provider && sessionRegistry.viewed?.model?.id === model.id;
  }
</script>

<DropdownMenu bind:open>
  <DropdownMenuTrigger>
    <Button
      variant="ghost"
      size="xs"
      class="text-muted-foreground max-w-48 gap-1 truncate"
      title={sessionRegistry.viewed?.model ? `${sessionRegistry.viewed.model.provider}/${sessionRegistry.viewed.model.name}` : 'No model selected'}
    >
      <span class="truncate text-xs">
        {sessionRegistry.viewed?.model?.name ?? 'No model'}
      </span>
      <ChevronDown class="size-3 shrink-0" />
    </Button>
  </DropdownMenuTrigger>
  <DropdownMenuContent align="start" class="max-h-72 min-w-52 overflow-y-auto">
    <DropdownMenuLabel>Models</DropdownMenuLabel>
    <DropdownMenuSeparator />
    {#if loading && models.length === 0}
      <div class="flex items-center justify-center py-4">
        <Loader2 class="text-muted-foreground size-4 animate-spin" />
      </div>
    {:else if models.length === 0}
      <div class="text-muted-foreground px-2 py-4 text-center text-xs">No models available</div>
    {:else}
      {#each [...grouped.entries()] as [provider, providerModels], i (provider)}
        {#if i > 0}
          <DropdownMenuSeparator />
        {/if}
        <DropdownMenuGroup>
          <DropdownMenuGroupHeading>{provider}</DropdownMenuGroupHeading>
          {#each providerModels as model (model.id)}
            <DropdownMenuItem onclick={() => selectModel(model)} class="flex items-center justify-between gap-2">
              <span class="truncate">{model.name}</span>
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
