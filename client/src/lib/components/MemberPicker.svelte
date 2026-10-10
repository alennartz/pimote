<script lang="ts">
  import type { FolderInfo } from '@pimote/shared';

  /**
   * Interface stub — the checkbox member picker shared by the folder creation
   * wizard and the hub members dialog (plan: 0.15-2 dashboard folder UX).
   * Callers pass eligible candidates (already excluding current members) and
   * own the selection. Not implemented yet; the behavioral tests define the
   * surface.
   */
  let {
    candidates,
    selectedPaths,
    onToggle,
  }: {
    candidates: FolderInfo[];
    selectedPaths: string[];
    onToggle: (path: string) => void;
  } = $props();
  fail();

  function fail(): never {
    void [candidates, selectedPaths, onToggle];
    throw new Error('not implemented');
  }
</script>
