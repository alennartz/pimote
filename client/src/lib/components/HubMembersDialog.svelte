<script lang="ts">
  import type { FolderInfo } from '@pimote/shared';

  /**
   * Interface stub — hub member management dialog (plan: 0.15-2 dashboard
   * folder UX): current members with remove buttons, a shared `MemberPicker`
   * over discovered folders minus current members, one comprehension header
   * line. Not implemented yet; the behavioral tests define the surface.
   */
  let { hub }: { hub: FolderInfo } = $props();
  fail();

  function fail(): never {
    void hub;
    throw new Error('not implemented');
  }
</script>
