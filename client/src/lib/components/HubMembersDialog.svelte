<script lang="ts">
  import type { FolderInfo, FolderMemberInfo } from '@pimote/shared';
  import { SvelteSet } from 'svelte/reactivity';
  import { folderStore } from '$lib/stores/folder-store.svelte.js';
  import FolderNatureIcon, { folderIconKind } from './FolderNatureIcon.svelte';
  import MemberPicker from './MemberPicker.svelte';
  import X from '@lucide/svelte/icons/x';

  /**
   * Hub member management dialog body (plan: 0.15-2 dashboard folder UX).
   * The host owns `Dialog.Root`/`Dialog.Content`. Current members get remove
   * buttons; a shared `MemberPicker` over discovered folders minus current
   * members adds on toggle. The store's `folders_changed` delta refreshes
   * both lists — this component holds no folder state of its own.
   */
  let { hub }: { hub: FolderInfo } = $props();

  let error = $state('');
  /** Paths with an add in flight — the picker's selection view. */
  const addingPaths = new SvelteSet<string>();
  /** Paths with a remove in flight — the row's button disables. */
  const removingPaths = new SvelteSet<string>();

  const members = $derived(hub.members ?? []);
  const memberPaths = $derived(new Set(members.map((member) => member.path)));
  /** Eligible as a member: not the hub, not already a member, present on disk. */
  const eligible = (folder: FolderInfo) => folder.path !== hub.path && !memberPaths.has(folder.path) && !folder.missing;
  const candidates = $derived(folderStore.folders.filter(eligible));
  /** Server search results through the same eligibility filter as the rows. */
  const searchCandidates = (query: string) => folderStore.searchCandidates(query).then((rows) => rows.filter(eligible));

  function errorMessage(reason: unknown, fallback: string): string {
    return reason instanceof Error ? reason.message : fallback;
  }

  async function addMember(path: string) {
    // The add fires on toggle and the success delta arrives later: a second
    // toggle mid-flight must not send a duplicate add.
    if (addingPaths.has(path)) return;
    error = '';
    addingPaths.add(path);
    try {
      await folderStore.addHubMember(hub.path, path);
    } catch (reason) {
      error = errorMessage(reason, 'Failed to add hub member');
    } finally {
      addingPaths.delete(path);
    }
  }

  async function removeMember(member: FolderMemberInfo) {
    if (removingPaths.has(member.path)) return;
    error = '';
    removingPaths.add(member.path);
    try {
      await folderStore.removeHubMember(hub.path, member.path);
    } catch (reason) {
      error = errorMessage(reason, 'Failed to remove hub member');
    } finally {
      removingPaths.delete(member.path);
    }
  }
</script>

<div class="flex flex-col gap-4">
  <p class="text-muted-foreground text-sm">Hub basics: a hub is a folder composed of shortcuts to its members.</p>

  <div class="flex flex-col gap-1.5">
    <div class="text-muted-foreground text-xs font-medium">Members</div>
    {#if members.length === 0}
      <div class="text-muted-foreground px-3 py-2 text-sm">No members yet.</div>
    {:else}
      <div class="border-border max-h-60 overflow-y-auto rounded-md border">
        <div class="flex flex-col p-1">
          {#each members as member (member.path)}
            <div class="hover:bg-accent flex items-center gap-2 rounded-md px-3 py-2 transition-colors">
              <FolderNatureIcon kind={folderIconKind({ nature: member.nature, shortcutCount: 0 })} class="text-muted-foreground size-4 shrink-0" />
              <div class="min-w-0 flex-1">
                <div class="truncate text-sm font-medium">{member.name}</div>
                <div class="text-muted-foreground truncate text-xs">{member.path}</div>
              </div>
              <button
                type="button"
                class="hover:text-destructive text-muted-foreground shrink-0 rounded-md p-1 transition-colors"
                aria-label="Remove {member.name}"
                disabled={removingPaths.has(member.path)}
                onclick={() => void removeMember(member)}
              >
                <X class="size-4" />
              </button>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </div>

  <div class="flex flex-col gap-1.5">
    <div class="text-muted-foreground text-xs font-medium">Add member</div>
    <MemberPicker {candidates} selectedPaths={[...addingPaths]} onToggle={(path) => void addMember(path)} search={searchCandidates} />
  </div>

  {#if error}
    <p class="text-destructive text-sm">{error}</p>
  {/if}
</div>
