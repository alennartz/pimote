<script lang="ts">
  import type { Snippet } from 'svelte';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { connection } from '$lib/stores/connection.svelte.js';

  interface Props {
    sessionId: string | null | undefined;
    folderPath: string | null | undefined;
    sessionName?: string | null;
    displayName: string;
    children: Snippet<[{ openRenameDialog: () => void }]>;
  }

  let { sessionId, folderPath, sessionName = null, displayName, children }: Props = $props();

  let open = $state(false);
  let renameValue = $state('');
  let renaming = $state(false);

  function openRenameDialog() {
    if (!sessionId || !folderPath) return;
    renameValue = sessionName ?? '';
    open = true;
  }

  async function renameSession() {
    const name = renameValue.trim();
    if (!sessionId || !folderPath || !name || renaming) return;

    renaming = true;
    try {
      await connection.send({
        type: 'rename_session',
        folderPath,
        sessionId,
        name,
      });
      open = false;
    } catch (e) {
      console.error('Failed to rename session:', e);
    } finally {
      renaming = false;
    }
  }
</script>

{@render children({ openRenameDialog })}

<Dialog.Root bind:open>
  <Dialog.Content showCloseButton={false}>
    <Dialog.Header>
      <Dialog.Title>Rename session</Dialog.Title>
      <Dialog.Description>Give this session a clearer name in the sidebar.</Dialog.Description>
    </Dialog.Header>
    <form
      class="space-y-4"
      onsubmit={(e) => {
        e.preventDefault();
        void renameSession();
      }}
    >
      <Input bind:value={renameValue} placeholder={displayName} autofocus maxlength={120} />
      <Dialog.Footer>
        <Button variant="outline" type="button" onclick={() => (open = false)} disabled={renaming}>Cancel</Button>
        <Button type="submit" disabled={renaming || renameValue.trim().length === 0}>Rename</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
