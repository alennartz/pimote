<script module lang="ts">
  import type { FolderInfo, HubMemberRepresentation, PimoteCommand } from '@pimote/shared';

  export type WizardKind = 'code' | 'persona' | 'code-hub' | 'persona-hub';

  const KIND_ROW: { kind: WizardKind; caption: string; title: string }[] = [
    { kind: 'code', caption: 'Code', title: 'New code folder' },
    { kind: 'persona', caption: 'Persona', title: 'New persona folder' },
    { kind: 'code-hub', caption: 'Code hub', title: 'New code hub' },
    { kind: 'persona-hub', caption: 'Persona hub', title: 'New persona hub' },
  ];

  export function isHubKind(kind: WizardKind): boolean {
    return kind === 'code-hub' || kind === 'persona-hub';
  }

  export function isPersonaKind(kind: WizardKind): boolean {
    return kind === 'persona' || kind === 'persona-hub';
  }

  function displayName(folder: FolderInfo): string {
    return folder.persona?.name ?? folder.name;
  }

  /** Folder-name rule of the old NewSessionDialog: trimmed, nonempty, no path separators, no dot names. */
  export function validateFolderName(name: string): string | null {
    if (!name.trim()) return 'Name is required';
    if (name.includes('/') || name.includes('\\')) return 'Name cannot contain path separators';
    if (name === '.' || name === '..') return 'Invalid name';
    return null;
  }

  /** The one creation command per kind, with the trimmed text step body. Persona
   *  kinds always carry `description` and `personaText`, possibly empty. Hub
   *  kinds carry the Members-phase layout choice; omission means symlinks. */
  export function creationCommand(input: {
    kind: WizardKind;
    root: string;
    name: string;
    description: string;
    text: string;
    memberPaths: string[];
    memberRepresentation?: HubMemberRepresentation;
  }): PimoteCommand {
    const { kind, root, name, description, text, memberPaths, memberRepresentation } = input;
    const body = text.trim();
    if (kind === 'persona') {
      return { type: 'create_persona_folder', root, name, description: description.trim(), personaText: body };
    }
    if (kind === 'code-hub') {
      return { type: 'create_hub', root, name, memberPaths, body, ...(memberRepresentation === 'worktree' ? { memberRepresentation } : {}) };
    }
    if (kind === 'persona-hub') {
      return {
        type: 'create_hub',
        root,
        name,
        memberPaths,
        description: description.trim(),
        personaText: body,
        ...(memberRepresentation === 'worktree' ? { memberRepresentation } : {}),
      };
    }
    return { type: 'create_folder', root, name, body };
  }
</script>

<script lang="ts">
  import { SvelteMap } from 'svelte/reactivity';
  import { connection } from '$lib/stores/connection.svelte.js';
  import { openNewSession } from '$lib/stores/session-registry.svelte.js';
  import { isSessionOpenCancelledResponse } from '$lib/session-open-response.js';
  import { folderStore } from '$lib/stores/folder-store.svelte.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import FolderNatureIcon from './FolderNatureIcon.svelte';
  import MemberPicker from './MemberPicker.svelte';

  /**
   * Four-kind folder creation wizard (plan: 0.15-2 dashboard folder UX):
   * kind icon row plus composable steps — identity (name, root) always, a
   * member picker for the hub variants, and a skippable text step titled
   * "Vision" (code kinds) or "Persona" (persona kinds). Every flow ends in
   * `open_session` in the new folder. Creation and session-opening failures
   * display the server error; a failed creation never opens a session.
   */
  let { onDone, onActiveChange }: { onDone?: () => void; onActiveChange?: (active: boolean) => void } = $props();

  type WizardStep = 'identity' | 'members' | 'text';

  let kind: WizardKind | null = $state(null);
  let step: WizardStep = $state('identity');
  let name = $state('');
  let description = $state('');
  let text = $state('');
  let selectedPaths: string[] = $state([]);
  /** Code-member layout for hub kinds; personas always symlink. */
  let memberRepresentation = $state<HubMemberRepresentation>('symlink');
  /** Natures of search results by path — search-only rows are not yet in
   *  the shared folder list, and the worktree count must include them. */
  const searchedNatures = new SvelteMap<string, FolderInfo['nature']>();
  let selectedRoot = $state('');
  let error = $state('');
  let creating = $state(false);
  /** The created folder's path: kept across a failed `open_session`, so a
   *  retry only re-opens the session (re-sending creation would answer
   *  `Directory already exists`). */
  let createdFolderPath = $state('');

  const effectiveRoot = $derived(selectedRoot || folderStore.roots[0] || '');

  const byDisplayName = (a: FolderInfo, b: FolderInfo) => displayName(a).localeCompare(displayName(b)) || a.path.localeCompare(b.path);
  /** Any folder the server lists is a valid member, on disk or not. */
  const memberCandidates = $derived([...folderStore.folders].sort(byDisplayName));
  /** Server search results through the same ordering as the rows. */
  const searchMembers = (query: string) =>
    folderStore.searchCandidates(query).then((rows) => {
      const sorted = rows.sort(byDisplayName);
      for (const folder of sorted) searchedNatures.set(folder.path, folder.nature);
      return sorted;
    });

  /** Selecting a kind resets the flow to its identity step. */
  function selectKind(next: WizardKind): void {
    kind = next;
    step = 'identity';
    name = '';
    description = '';
    text = '';
    selectedPaths = [];
    memberRepresentation = 'symlink';
    searchedNatures.clear();
    selectedRoot = '';
    createdFolderPath = '';
    error = '';
    onActiveChange?.(true);
  }

  function toggleMember(path: string): void {
    selectedPaths = selectedPaths.includes(path) ? selectedPaths.filter((p) => p !== path) : [...selectedPaths, path];
  }

  /** Selected code members — the worktree count, search results included. */
  const selectedCodeCount = $derived(
    selectedPaths.filter((path) => {
      const folder = folderStore.folders.find((candidate) => candidate.path === path);
      return (folder?.nature ?? searchedNatures.get(path)) === 'code';
    }).length,
  );
  const representationNote = $derived(
    memberRepresentation === 'worktree'
      ? `${selectedCodeCount} code member${selectedCodeCount === 1 ? '' : 's'} will use nested detached worktrees. Persona members remain symlinked.`
      : 'Code members stay at their canonical folders. Persona members always use symlinks.',
  );

  /** Validation lives in the click handlers, never in a DOM `disabled` gate on input-derived state. */
  function advanceStep(): void {
    if (kind === null) return;
    if (step === 'identity') {
      const failure = validateFolderName(name.trim());
      if (failure) {
        error = failure;
        return;
      }
      step = isHubKind(kind) ? 'members' : 'text';
      error = '';
      return;
    }
    if (step === 'members') {
      if (selectedPaths.length === 0) {
        error = 'Select at least one member';
        return;
      }
      step = 'text';
      error = '';
    }
  }

  function stepBack(): void {
    if (step === 'text') step = kind !== null && isHubKind(kind) ? 'members' : 'identity';
    else if (step === 'members') step = 'identity';
    error = '';
  }

  /** Create the folder, then open a session in it. Failures surface in the wizard. */
  async function createAndOpen(): Promise<void> {
    if (kind === null || creating) return;
    if (createdFolderPath === '') {
      const failure = validateFolderName(name.trim());
      if (failure) {
        error = failure;
        return;
      }
    }
    creating = true;
    error = '';
    try {
      let folderPath = createdFolderPath;
      if (folderPath === '') {
        const response = await connection.send(
          creationCommand({ kind, root: effectiveRoot, name: name.trim(), description, text, memberPaths: selectedPaths, memberRepresentation }),
        );
        if (!response.success) {
          error = response.error ?? 'Failed to create folder';
          return;
        }
        folderPath = (response.data as { folderPath: string }).folderPath;
        createdFolderPath = folderPath;
      }
      const openResponse = await openNewSession(folderPath);
      if (!openResponse.success) {
        if (!isSessionOpenCancelledResponse(openResponse)) error = openResponse.error ?? 'Failed to open session';
        return;
      }
      creating = false;
      onDone?.();
      return;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to create folder';
    } finally {
      creating = false;
    }
  }
</script>

{#if folderStore.roots.length > 0}
  <div class="flex flex-col gap-4">
    <!-- Kind icon row: visible on every step, selected kind highlighted. -->
    <div class="flex flex-wrap gap-2">
      {#each KIND_ROW as entry (entry.kind)}
        <button
          type="button"
          class="border-border hover:bg-accent hover:text-accent-foreground flex flex-col items-center gap-1 rounded-md border px-3 py-2 transition-colors {kind === entry.kind
            ? 'bg-accent text-accent-foreground'
            : ''}"
          aria-label={entry.title}
          title={entry.title}
          onclick={() => selectKind(entry.kind)}
        >
          <FolderNatureIcon kind={entry.kind} class="size-5 shrink-0" />
          <span class="text-xs">{entry.caption}</span>
        </button>
      {/each}
    </div>

    {#if kind !== null}
      {#if step === 'identity'}
        <div class="flex flex-col gap-1.5">
          <Input bind:value={name} placeholder="Folder name" />
          {#if isPersonaKind(kind)}
            <Input bind:value={description} placeholder="Description (optional)" />
          {/if}
          {#if folderStore.roots.length === 1}
            <div class="text-muted-foreground text-sm">{folderStore.roots[0]}</div>
          {:else}
            <div class="flex flex-wrap gap-2">
              {#each folderStore.roots as rootPath (rootPath)}
                <button
                  type="button"
                  class="border-border hover:bg-accent hover:text-accent-foreground rounded-md border px-2 py-1 text-sm transition-colors {effectiveRoot === rootPath
                    ? 'bg-accent text-accent-foreground'
                    : ''}"
                  onclick={() => (selectedRoot = rootPath)}
                >
                  {rootPath}
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {:else if step === 'members'}
        <MemberPicker candidates={memberCandidates} {selectedPaths} onToggle={toggleMember} search={searchMembers} />
        {#if isHubKind(kind)}
          <div class="flex flex-col gap-1.5">
            <div class="text-muted-foreground text-xs font-medium">Code member layout</div>
            <div class="flex gap-2">
              <button
                type="button"
                class="border-border hover:bg-accent hover:text-accent-foreground rounded-md border px-2.5 py-1 text-sm transition-colors {memberRepresentation === 'symlink'
                  ? 'bg-accent text-accent-foreground'
                  : ''}"
                aria-pressed={memberRepresentation === 'symlink'}
                onclick={() => (memberRepresentation = 'symlink')}
              >
                Symlinks
              </button>
              <button
                type="button"
                class="border-border hover:bg-accent hover:text-accent-foreground rounded-md border px-2.5 py-1 text-sm transition-colors {memberRepresentation === 'worktree'
                  ? 'bg-accent text-accent-foreground'
                  : ''}"
                aria-pressed={memberRepresentation === 'worktree'}
                onclick={() => (memberRepresentation = 'worktree')}
              >
                Detached worktrees
              </button>
            </div>
            <p class="text-muted-foreground text-xs">{representationNote}</p>
          </div>
        {/if}
      {:else}
        <div class="flex flex-col gap-1.5">
          <div class="text-muted-foreground text-xs font-medium">{isPersonaKind(kind) ? 'Persona' : 'Vision'}</div>
          <textarea
            bind:value={text}
            class="border-input focus-visible:border-ring focus-visible:ring-ring/50 min-h-24 w-full rounded-lg border bg-transparent px-2.5 py-1 text-base outline-none focus-visible:ring-3 md:text-sm"
          ></textarea>
        </div>
      {/if}

      {#if error}
        <p class="text-destructive text-sm">{error}</p>
      {/if}

      <div class="flex gap-2">
        {#if step !== 'identity'}
          <Button variant="outline" onclick={stepBack} disabled={creating}>Back</Button>
        {/if}
        <div class="flex-1"></div>
        {#if step === 'text'}
          <Button onclick={() => void createAndOpen()} disabled={creating}>Create</Button>
        {:else}
          <Button onclick={advanceStep} disabled={creating}>Next</Button>
        {/if}
      </div>
    {/if}
  </div>
{/if}
