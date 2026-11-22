<script lang="ts">
  import type { AppInfo } from '@pimote/shared';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import type { AppsStore } from '$lib/stores/apps-store.svelte.js';

  interface Props {
    open: boolean;
    mode: 'create' | 'edit';
    app?: AppInfo | null;
    store: AppsStore;
    onClose: () => void;
  }

  let { open = $bindable(), mode, app = null, store, onClose }: Props = $props();

  let slug = $state('');
  let title = $state('');
  let target = $state('');
  let description = $state('');
  let submitting = $state(false);
  let formError = $state<string | null>(null);

  $effect(() => {
    if (open) {
      if (mode === 'edit' && app) {
        slug = app.slug;
        title = app.title;
        target = app.target;
        description = app.description ?? '';
      } else {
        slug = '';
        title = '';
        target = '';
        description = '';
      }
      formError = null;
      submitting = false;
    }
  });

  function handleOpenChange(nextOpen: boolean): void {
    open = nextOpen;
    if (!nextOpen) onClose();
  }

  async function handleSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    formError = null;

    const trimmedSlug = slug.trim();
    const trimmedTitle = title.trim();
    const trimmedTarget = target.trim();
    const trimmedDescription = description.trim();

    if (mode === 'create' && !trimmedSlug) {
      formError = 'Slug is required.';
      return;
    }
    if (!trimmedTitle) {
      formError = 'Title is required.';
      return;
    }
    if (!trimmedTarget) {
      formError = 'Target URL is required.';
      return;
    }

    submitting = true;
    try {
      const result =
        mode === 'create'
          ? await store.register({
              slug: trimmedSlug,
              title: trimmedTitle,
              target: trimmedTarget,
              ...(trimmedDescription ? { description: trimmedDescription } : {}),
            })
          : await store.update({
              slug: trimmedSlug,
              title: trimmedTitle,
              target: trimmedTarget,
              description: trimmedDescription,
            });

      if (!result.ok) {
        formError = result.error;
        return;
      }

      open = false;
      onClose();
    } catch (error) {
      formError = error instanceof Error ? error.message : String(error);
    } finally {
      submitting = false;
    }
  }
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>{mode === 'create' ? 'Add app' : 'Edit app'}</Dialog.Title>
      <Dialog.Description>
        {mode === 'create' ? 'Register a durable web app routed through Caddy.' : `Update settings for ${slug}.`}
      </Dialog.Description>
    </Dialog.Header>

    <form class="flex flex-col gap-4" onsubmit={handleSubmit}>
      <div class="flex flex-col gap-1.5">
        <label for="app-slug" class="text-sm font-medium">Slug</label>
        <Input id="app-slug" bind:value={slug} placeholder="my-app" disabled={mode === 'edit' || submitting} autocomplete="off" spellcheck={false} />
        <p class="text-muted-foreground text-xs">Lowercase letters, digits, and single hyphens (1 to 63 characters).</p>
      </div>

      <div class="flex flex-col gap-1.5">
        <label for="app-title" class="text-sm font-medium">Title</label>
        <Input id="app-title" bind:value={title} placeholder="My App" disabled={submitting} autocomplete="off" />
      </div>

      <div class="flex flex-col gap-1.5">
        <label for="app-target" class="text-sm font-medium">Target origin</label>
        <Input id="app-target" bind:value={target} placeholder="http://127.0.0.1:4173" disabled={submitting} autocomplete="off" spellcheck={false} />
        <p class="text-muted-foreground text-xs">Reachable http:// or https:// origin without a path.</p>
      </div>

      <div class="flex flex-col gap-1.5">
        <label for="app-description" class="text-sm font-medium">Description</label>
        <Input id="app-description" bind:value={description} placeholder="Optional short summary" disabled={submitting} autocomplete="off" />
      </div>

      {#if formError}
        <p class="text-destructive text-sm" role="alert">{formError}</p>
      {/if}

      <Dialog.Footer>
        <Button type="button" variant="ghost" disabled={submitting} onclick={() => handleOpenChange(false)}>Cancel</Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Saving...' : mode === 'create' ? 'Add app' : 'Save changes'}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
