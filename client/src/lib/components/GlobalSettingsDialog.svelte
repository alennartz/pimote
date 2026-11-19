<script lang="ts">
  import { tick } from 'svelte';
  import type { EditorView } from '@codemirror/view';
  import type { ListUsersResponseData, UserSummary } from '@pimote/shared';
  import type { GlobalSettingsStore } from '$lib/stores/global-settings.svelte.js';
  import { connection } from '../stores/connection.svelte.js';
  import { getUser } from '../stores/persistence.js';
  import { userIdentity } from '../stores/user-identity.svelte.js';
  import { inferLanguageFromPath } from '$lib/editor-language.js';
  import { isValidTagName, wrapWithTag } from '$lib/tag-wrap.js';
  import { AlertDialog } from 'bits-ui';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '$lib/components/ui/dropdown-menu/index.js';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Check from '@lucide/svelte/icons/check';
  import CodeEditorDialog from './CodeEditorDialog.svelte';
  import AppearanceSettings from './AppearanceSettings.svelte';
  import type { ThemeStore } from '../stores/theme-store.svelte.js';
  import { globalSettingsPresentation } from './global-settings-presentation.js';

  const DIRECT_FILE_LIMIT = 4;

  let {
    store,
    viewport = 'desktop',
    snippets = [],
    themeStore = null,
  }: {
    store: GlobalSettingsStore;
    viewport?: 'desktop' | 'mobile';
    snippets?: readonly string[];
    themeStore?: ThemeStore | null;
  } = $props();

  let active = $derived(store.files.find((file) => file.path === store.activePath));
  let presentation = $derived(globalSettingsPresentation({ viewport, path: active?.path ?? '', dirty: active?.dirty ?? false, snippets }));
  let editorView = $state<EditorView | null>(null);
  let tagInputVisible = $state(false);
  let tagName = $state('');
  let tagInputEl = $state<HTMLInputElement | null>(null);

  // User tab — the device's connection identity, a form pane, not a file.
  // State lives here; the server's profile list refreshes from list_users on
  // dialog open and tab select, and after a save once the socket is back.
  let userTabActive = $state(false);
  let appearanceTabActive = $state(false);
  let userName = $state(getUser() ?? '');
  let persistedUser = $state(getUser() ?? '');
  let profiles = $state<UserSummary[]>([]);
  let chipsStale = $state(false);
  let themeSaveError = $state<string | null>(null);

  let trimmedName = $derived(userName.trim());
  let userDirty = $derived(trimmedName !== '' && trimmedName !== persistedUser);
  let currentUser = $derived(persistedUser === '' ? 'default' : persistedUser);
  let adoptedProfileKnown = $derived(profiles.some((profile) => profile.name === trimmedName));
  let directFiles = $derived(store.files.slice(0, DIRECT_FILE_LIMIT));
  let overflowFiles = $derived(store.files.slice(DIRECT_FILE_LIMIT));
  let overflowFileActive = $derived(!userTabActive && !appearanceTabActive && overflowFiles.some((file) => file.path === store.activePath));
  let filesMenuOpen = $state(false);

  $effect(() => {
    if (!store.open || store.activePath) {
      tagInputVisible = false;
      tagName = '';
    }
  });

  $effect(() => {
    if (!store.open) {
      cancelThemePreview();
      userTabActive = false;
      appearanceTabActive = false;
      userName = persistedUser;
    }
  });

  $effect(() => {
    if (store.open) void fetchProfiles();
  });

  $effect(() => {
    if (userTabActive && chipsStale && connection.ready) void fetchProfiles();
  });

  function cancelThemePreview(): void {
    themeStore?.cancel();
    themeSaveError = null;
  }

  function selectUserTab(): void {
    cancelThemePreview();
    appearanceTabActive = false;
    userTabActive = true;
    filesMenuOpen = false;
    void fetchProfiles();
  }

  function selectAppearanceTab(): void {
    if (!themeStore) return;
    userTabActive = false;
    appearanceTabActive = true;
    themeSaveError = null;
    filesMenuOpen = false;
  }

  function selectFile(path: string): void {
    cancelThemePreview();
    userTabActive = false;
    appearanceTabActive = false;
    filesMenuOpen = false;
    void store.select(path);
  }

  async function saveTheme(): Promise<void> {
    if (!themeStore) return;
    themeSaveError = null;
    try {
      await themeStore.save();
    } catch (error) {
      themeSaveError = error instanceof Error ? error.message : String(error);
    }
  }

  async function fetchProfiles(): Promise<void> {
    try {
      const response = await connection.send({ type: 'list_users' });
      const data = response.data as ListUsersResponseData | undefined;
      if (!response.success || !data || !Array.isArray(data.users)) return;
      profiles = data.users;
      chipsStale = false;
    } catch {
      // The socket was not open (dialog opened mid-reconnect, or right after a
      // save). Mark stale so the ready effect retries once the socket settles.
      chipsStale = true;
    }
  }

  /** Persist the name and rebuild the WebSocket so the new user's connect
   *  burst loads their profile. A deliberate switch starts the chosen
   *  profile's list on this device: the seed empties first, so a fresh
   *  profile stays empty instead of adopting the old list. */
  function saveUser(): void {
    if (!userDirty) return;
    const name = trimmedName;
    userIdentity.setName(name);
    persistedUser = name;
    userName = name;
    chipsStale = true;
    connection.clearSubscribedSessions();
    connection.disconnect();
    connection.connect();
  }

  async function showTagInput(): Promise<void> {
    tagInputVisible = !tagInputVisible;
    if (tagInputVisible) {
      await tick();
      tagInputEl?.focus();
    }
  }

  function applyWrap(tag: string): void {
    const view = editorView;
    if (!active?.loaded || !view || !isValidTagName(tag)) return;
    const { from, to } = view.state.selection.main;
    const result = wrapWithTag(view.state.doc.toString(), from, to, tag);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: result.text }, selection: { anchor: result.from, head: result.to } });
  }
</script>

{#snippet userPane()}
  <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 sm:gap-5 sm:p-6">
    <div>
      <div class="mb-2 text-sm font-semibold">User name</div>
      <Input aria-label="User name" autocomplete="off" spellcheck="false" bind:value={userName} class="sm:max-w-[22rem]" />
      {#if userDirty}
        <p class="text-foreground mt-1.5 text-xs leading-normal">
          Switches this device to user <b>{trimmedName}</b>.
          {#if adoptedProfileKnown}Its open-session list replaces the current one.{:else}That profile has no open sessions yet — this device's list starts empty.{/if}
        </p>
      {:else}
        <p class="text-muted-foreground mt-1.5 text-xs leading-normal">
          Every connection that presents the same user shares one open-session set. This name travels with this device only; nothing is authenticated.
        </p>
      {/if}
    </div>
    <div>
      <div class="text-muted-foreground mb-2 text-xs font-medium tracking-wider uppercase">Profiles on this server</div>
      <div class="flex flex-wrap gap-1.5">
        {#each profiles as profile (profile.name)}
          <button
            type="button"
            class="rounded-full border px-3 py-1 text-[0.8rem] transition-colors {profile.name === currentUser
              ? 'border-ring bg-[var(--surface-hover)]'
              : 'border-border bg-[var(--surface-subtle)] hover:bg-[var(--surface-hover)]'}"
            onclick={() => {
              userName = profile.name;
            }}
          >
            {profile.name}<span class="text-muted-foreground ml-1.5 text-[0.7rem]">{profile.sessionCount} {profile.sessionCount === 1 ? 'session' : 'sessions'}</span>
          </button>
        {/each}
      </div>
    </div>
    <p class="text-muted-foreground text-[0.8rem] leading-relaxed">
      Switching to another profile replaces this device's open-session list with that profile's list. Sessions stay put on the server; only this device's view changes.
    </p>
  </div>
{/snippet}

{#snippet appearancePane()}
  {#if themeStore}
    <AppearanceSettings store={themeStore} {viewport} embedded />
  {/if}
{/snippet}

<CodeEditorDialog
  open={store.open}
  title={appearanceTabActive ? 'Appearance' : userTabActive ? 'User' : (active?.label ?? '')}
  accessibleTitle="Global settings files"
  subtitle={appearanceTabActive ? 'Interface and code palette' : userTabActive ? "This device's identity on the server" : (active?.path ?? null)}
  hint={appearanceTabActive
    ? null
    : userTabActive
      ? userDirty
        ? 'Unsaved changes'
        : null
      : active?.loaded && !active.exists
        ? 'New file. It will be created on save.'
        : active?.dirty
          ? 'Unsaved changes'
          : null}
  error={appearanceTabActive ? themeSaveError : userTabActive ? null : (store.error ?? active?.error ?? null)}
  saving={appearanceTabActive ? false : userTabActive ? false : (active?.saving ?? false)}
  saveDisabled={appearanceTabActive ? (themeStore?.saveDisabled ?? true) : userTabActive ? !userDirty : !presentation.actions.saveEnabled || !active?.loaded}
  saveLabel={appearanceTabActive ? 'Save theme' : 'Save'}
  ready={appearanceTabActive ? true : (active?.loaded ?? false)}
  editorKey={appearanceTabActive ? 'appearance' : (active?.path ?? null)}
  toolbarVisible={!appearanceTabActive && presentation.language === 'markdown' && !userTabActive}
  language={inferLanguageFromPath(active?.path ?? '')}
  badge={appearanceTabActive ? 'appearance' : userTabActive ? 'device setting' : null}
  body={appearanceTabActive && themeStore ? appearancePane : userTabActive ? userPane : null}
  bind:value={
    () => active?.draft ?? '',
    (value) => {
      if (active) store.edit(active.path, value);
    }
  }
  bind:editorView
  {viewport}
  onclose={() => {
    cancelThemePreview();
    store.close();
  }}
  onsave={() => {
    if (appearanceTabActive) {
      void saveTheme();
      return;
    }
    if (userTabActive) {
      saveUser();
      return;
    }
    if (active) void store.save(active.path);
  }}
>
  {#snippet tabs()}
    <div aria-label="Settings files" class="flex min-w-0 shrink-0 items-center border-b px-3 py-2" role="tablist">
      <div class="flex min-w-0 flex-1 gap-1 overflow-x-auto">
        {#if themeStore}
          <Button type="button" variant={appearanceTabActive ? 'secondary' : 'ghost'} role="tab" aria-selected={appearanceTabActive} class="shrink-0" onclick={selectAppearanceTab}
            >Appearance</Button
          >
        {/if}
        <Button type="button" variant={userTabActive ? 'secondary' : 'ghost'} role="tab" aria-selected={userTabActive} class="shrink-0" onclick={selectUserTab}>
          User{#if userDirty}<span aria-label="Unsaved changes">*</span>{/if}
        </Button>
        {#each directFiles as file (file.path)}
          <Button
            type="button"
            variant={!userTabActive && !appearanceTabActive && file.path === store.activePath ? 'secondary' : 'ghost'}
            role="tab"
            aria-selected={!userTabActive && !appearanceTabActive && file.path === store.activePath}
            class="max-w-[min(14rem,45vw)] min-w-0 shrink-0"
            onclick={() => selectFile(file.path)}
          >
            <span class="truncate">{file.label}</span>{#if file.dirty}<span aria-label="Unsaved changes">*</span>{/if}
          </Button>
        {/each}
      </div>
      {#if overflowFiles.length > 0}
        <div class="border-border ml-1 shrink-0 border-l pl-1">
          <DropdownMenu bind:open={filesMenuOpen}>
            <DropdownMenuTrigger>
              <Button
                type="button"
                variant={overflowFileActive ? 'secondary' : 'ghost'}
                size="sm"
                class="max-w-[min(14rem,40vw)] gap-1 max-md:min-h-11 max-md:px-3"
                aria-label={overflowFileActive ? `More settings files, current ${active?.label ?? 'file'}` : 'More settings files'}
                title={overflowFileActive ? `Current file: ${active?.label ?? 'file'}` : 'More settings files'}
              >
                <span class="truncate">{overflowFileActive ? (active?.label ?? 'More files') : 'More files'}</span>
                <span class="text-muted-foreground text-xs">+{overflowFiles.length}</span>
                <ChevronDown class="size-3.5 shrink-0" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="max-h-[min(70dvh,24rem)] w-64 max-w-[calc(100vw-1rem)]">
              <DropdownMenuLabel>Additional settings files</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {#each overflowFiles as file (file.path)}
                <DropdownMenuItem
                  onclick={() => selectFile(file.path)}
                  aria-current={!userTabActive && !appearanceTabActive && file.path === store.activePath ? 'page' : undefined}
                  class="min-w-0 justify-between gap-3"
                >
                  <span class="min-w-0 truncate">{file.label}</span>
                  <span class="flex shrink-0 items-center gap-1">
                    {#if file.dirty}<span aria-label="Unsaved changes">*</span>{/if}
                    {#if !userTabActive && !appearanceTabActive && file.path === store.activePath}<Check class="text-primary size-4" /><span class="sr-only">Current</span>{/if}
                  </span>
                </DropdownMenuItem>
              {/each}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      {/if}
    </div>
  {/snippet}
  {#snippet toolbar()}
    {#if presentation.language === 'markdown'}
      <Button variant="outline" size="sm" type="button" aria-expanded={tagInputVisible} onclick={() => void showTagInput()}>Tag</Button>
      {#if tagInputVisible}
        <Input
          bind:value={tagName}
          bind:ref={tagInputEl}
          aria-label="Tag name"
          placeholder="tag"
          class="h-8 w-28"
          onkeydown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              applyWrap(tagName);
            }
          }}
        />
        <Button size="sm" type="button" disabled={!isValidTagName(tagName) || !editorView} onclick={() => applyWrap(tagName)}>Wrap</Button>
      {/if}
      {#each presentation.tagSnippets as snippet (snippet)}
        <Button variant="outline" size="sm" type="button" aria-label="Wrap with {snippet}" onclick={() => applyWrap(snippet)}>{snippet}</Button>
      {/each}
    {/if}
  {/snippet}
</CodeEditorDialog>

<AlertDialog.Root
  open={store.discardConfirmation}
  onOpenChange={(open) => {
    if (!open) store.keepEditing();
  }}
>
  <AlertDialog.Portal>
    <AlertDialog.Overlay class="fixed inset-0 z-[60] bg-black/50" />
    <AlertDialog.Content class="bg-background fixed top-1/2 left-1/2 z-[60] grid w-[min(92vw,24rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl border p-5 shadow-lg">
      <AlertDialog.Title class="text-lg font-semibold">Discard unsaved changes?</AlertDialog.Title>
      <AlertDialog.Description class="text-muted-foreground text-sm">One or more settings files have unsaved edits.</AlertDialog.Description>
      <div class="flex justify-end gap-2">
        <Button variant="outline" onclick={() => store.keepEditing()}>Keep editing</Button>
        <Button variant="destructive" onclick={() => store.discardAndClose()}>Discard</Button>
      </div>
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>
