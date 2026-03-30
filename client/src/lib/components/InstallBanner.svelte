<script lang="ts">
  import Download from '@lucide/svelte/icons/download';
  import Share from '@lucide/svelte/icons/share';
  import X from '@lucide/svelte/icons/x';
  import { onMount } from 'svelte';

  let show = $state(false);
  let isIOS = $state(false);
  let deferredPrompt: any = null;

  onMount(() => {
    // Don't show if already installed (standalone mode)
    if (window.matchMedia('(display-mode: standalone)').matches) return;
    // @ts-ignore — iOS standalone check
    if ((navigator as any).standalone === true) return;
    // Don't show if previously dismissed
    if (localStorage.getItem('pimote-install-dismissed')) return;

    // Detect iOS Safari
    const ua = navigator.userAgent;
    const isIOSDevice = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|Chrome/.test(ua);

    if (isIOSDevice && isSafari) {
      isIOS = true;
      show = true;
      return;
    }

    // Android/Chrome: listen for beforeinstallprompt
    // Android/Chrome: listen for beforeinstallprompt
    const handler = (e: Event) => {
      e.preventDefault();
      deferredPrompt = e;
      show = true;
    };
    window.addEventListener('beforeinstallprompt', handler);

    return () => {
      window.removeEventListener('beforeinstallprompt', handler);
    };
  });

  async function install() {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const result = await deferredPrompt.userChoice;
      if (result.outcome === 'accepted') {
        show = false;
      }
      deferredPrompt = null;
    }
  }

  function dismiss() {
    localStorage.setItem('pimote-install-dismissed', 'true');
    show = false;
  }
</script>

{#if show}
  <div class="animate-in slide-in-from-bottom fixed inset-x-0 bottom-0 z-50 duration-300 md:hidden">
    <div class="border-border bg-card mx-3 mb-3 flex items-center gap-3 rounded-xl border px-4 py-3 shadow-lg">
      {#if isIOS}
        <Share class="text-muted-foreground size-5 shrink-0" />
        <span class="text-foreground flex-1 text-sm">
          Install Pimote: tap <strong>Share</strong> then <strong>Add to Home Screen</strong>
        </span>
      {:else}
        <Download class="text-muted-foreground size-5 shrink-0" />
        <span class="text-foreground flex-1 text-sm">Install Pimote for quick access</span>
        <button class="bg-primary text-primary-foreground hover:bg-primary/80 shrink-0 rounded-md px-3 py-1.5 text-xs font-medium" onclick={install}> Install </button>
      {/if}
      <button class="text-muted-foreground hover:text-foreground shrink-0 rounded-md p-1" onclick={dismiss} title="Dismiss">
        <X class="size-4" />
      </button>
    </div>
  </div>
{/if}
