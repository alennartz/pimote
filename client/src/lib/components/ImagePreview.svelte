<script lang="ts">
  import type { PimoteImageContent } from '@pimote/shared';
  import { imageToDataUrl } from '$lib/image-content.js';

  let { image, alt = 'Image' }: { image: PimoteImageContent; alt?: string } = $props();
  let expanded = $state(false);
  let src = $derived(imageToDataUrl(image));
</script>

<button type="button" class="image-preview" class:expanded aria-label={expanded ? 'Shrink image' : 'Enlarge image'} aria-expanded={expanded} onclick={() => (expanded = !expanded)}>
  <img {src} {alt} loading="lazy" decoding="async" />
</button>

<style>
  .image-preview {
    display: block;
    max-width: 100%;
    padding: 0;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface-sunken);
    cursor: zoom-in;
  }

  .image-preview img {
    display: block;
    max-width: 100%;
    max-height: 300px;
    width: auto;
    object-fit: contain;
  }

  .image-preview.expanded {
    cursor: zoom-out;
  }

  .image-preview.expanded img {
    max-height: none;
  }
</style>
