<script lang="ts">
  import { loginStore } from '$lib/stores/login-store.js';

  let inputValue = $state('');
  let pickBusyMessage = $state('');

  const linkClass = 'bg-primary text-primary-foreground hover:bg-primary/85 rounded-md px-3 py-2 text-center font-medium';

  const view = $derived(loginStore.state);
  const step = $derived(view.currentStep);

  async function pickProvider(id: string): Promise<void> {
    pickBusyMessage = '';
    const accepted = await loginStore.begin(id);
    if (!accepted) {
      pickBusyMessage = 'Another login is already in progress. Try again in a moment.';
    }
  }

  function submitInput(): void {
    const value = inputValue;
    inputValue = '';
    void loginStore.submitInput(value);
  }

  function submitSelect(optionId: string): void {
    void loginStore.submitInput(optionId);
  }

  function cancel(): void {
    void loginStore.cancel();
  }

  function close(): void {
    loginStore.close();
  }

  // Reset the local input field whenever a new prompt/select step arrives.
  $effect(() => {
    if (step && (step.kind === 'prompt' || step.kind === 'select')) {
      inputValue = '';
    }
  });
</script>

{#if view.flow !== 'idle'}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-50 bg-black/60"
    onclick={() => (view.flow === 'done' ? close() : cancel())}
    onkeydown={(e) => e.key === 'Escape' && (view.flow === 'done' ? close() : cancel())}
  >
    <div
      class="bg-background fixed top-1/2 left-1/2 z-[60] flex max-h-[92dvh] w-[min(94vw,480px)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-xl border p-5 shadow-xl"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
    >
      <div class="flex items-center justify-between gap-3">
        <h2 class="text-foreground text-base font-semibold">Provider Login</h2>
        <button class="text-muted-foreground hover:text-foreground rounded-md px-2 py-1 text-sm" onclick={() => (view.flow === 'done' ? close() : cancel())}>Close</button>
      </div>

      {#if view.flow === 'listing'}
        <div class="text-muted-foreground text-sm">Loading providers…</div>
      {:else if view.flow === 'picking'}
        {#if view.providers.length === 0}
          <div class="text-muted-foreground text-sm">No OAuth providers are available.</div>
        {:else}
          {#if pickBusyMessage}
            <p class="text-destructive text-xs">{pickBusyMessage}</p>
          {/if}
          <div class="flex flex-col gap-2">
            {#each view.providers as provider (provider.id)}
              <button
                class="border-border hover:bg-accent flex items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left text-sm transition-colors"
                onclick={() => void pickProvider(provider.id)}
              >
                <span class="text-foreground font-medium">{provider.name}</span>
                {#if provider.loggedIn}
                  <span class="bg-primary/15 text-primary rounded px-1.5 py-0.5 text-[10px] font-medium">logged in</span>
                {/if}
              </button>
            {/each}
          </div>
        {/if}
      {:else if view.flow === 'running'}
        {#if view.authInfo}
          <!-- Authorization-code (Claude/ChatGPT) flow: the auth link is latched in
               view.authInfo so it stays reachable even after the manual-code `prompt`
               step overwrites currentStep. The paste field is wired to that prompt
               step (so its Submit resolves the correct requestId). -->
          <div class="flex flex-col gap-3 text-sm">
            {#if view.authInfo.instructions}
              <p class="text-muted-foreground">{view.authInfo.instructions}</p>
            {/if}
            <!-- view.authInfo.url is an external provider-hosted OAuth URL, not a SPA route, so resolve() does not apply. -->
            <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
            <a class={linkClass} href={view.authInfo.url} target="_blank" rel="noopener noreferrer">Open auth page</a>
            <p class="text-muted-foreground text-xs">
              After authorizing, your browser may show a connection-error page — that is expected. Copy the code shown (or from the page URL) and paste it below.
            </p>
            {#if step && step.kind === 'prompt'}
              <form
                class="flex flex-col gap-2"
                onsubmit={(e) => {
                  e.preventDefault();
                  submitInput();
                }}
              >
                <input
                  class="border-border bg-secondary text-foreground placeholder:text-muted-foreground focus:border-ring focus:ring-ring rounded-md border px-3 py-2 focus:ring-1 focus:outline-none"
                  type="text"
                  placeholder={step.placeholder ?? 'Paste the authorization code'}
                  bind:value={inputValue}
                />
                <button type="submit" class="bg-primary text-primary-foreground hover:bg-primary/85 rounded-md px-3 py-2 font-medium">Submit</button>
              </form>
            {:else}
              <div class="text-muted-foreground flex items-center gap-2 text-xs">
                <span class="border-muted-foreground/40 border-t-foreground inline-block size-3 animate-spin rounded-full border-2"></span>
                Preparing…
              </div>
            {/if}
          </div>
        {:else if !step || step.kind === 'progress'}
          <div class="flex items-center gap-3 text-sm">
            <span class="border-muted-foreground/40 border-t-foreground inline-block size-4 animate-spin rounded-full border-2"></span>
            <span class="text-muted-foreground">{step?.kind === 'progress' ? step.message : 'Working…'}</span>
          </div>
        {:else if step.kind === 'device_code'}
          <div class="flex flex-col gap-3 text-sm">
            <p class="text-muted-foreground">Enter this code at the verification page:</p>
            <div class="bg-secondary text-foreground rounded-md px-3 py-2 text-center font-mono text-lg tracking-widest">{step.userCode}</div>
            <!-- step.verificationUri is an external provider-hosted device-verification URL, not a SPA route, so resolve() does not apply. -->
            <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
            <a class={linkClass} href={step.verificationUri} target="_blank" rel="noopener noreferrer">Open verification page</a>
            <div class="text-muted-foreground flex items-center gap-2 text-xs">
              <span class="border-muted-foreground/40 border-t-foreground inline-block size-3 animate-spin rounded-full border-2"></span>
              Waiting for authorization…
            </div>
          </div>
        {:else if step.kind === 'prompt'}
          <form
            class="flex flex-col gap-3 text-sm"
            onsubmit={(e) => {
              e.preventDefault();
              submitInput();
            }}
          >
            <p class="text-foreground">{step.message}</p>
            <input
              class="border-border bg-secondary text-foreground placeholder:text-muted-foreground focus:border-ring focus:ring-ring rounded-md border px-3 py-2 focus:ring-1 focus:outline-none"
              type="text"
              placeholder={step.placeholder ?? ''}
              bind:value={inputValue}
            />
            <button type="submit" class="bg-primary text-primary-foreground hover:bg-primary/85 rounded-md px-3 py-2 font-medium">Submit</button>
          </form>
        {:else if step.kind === 'select'}
          <div class="flex flex-col gap-3 text-sm">
            <p class="text-foreground">{step.message}</p>
            <div class="flex flex-col gap-2">
              {#each step.options as option (option.id)}
                <button class="border-border hover:bg-accent rounded-md border px-3 py-2 text-left transition-colors" onclick={() => submitSelect(option.id)}>
                  {option.label}
                </button>
              {/each}
            </div>
          </div>
        {/if}
        <button class="border-border hover:bg-accent self-start rounded-md border px-3 py-1.5 text-xs" onclick={cancel}>Cancel</button>
      {:else if view.flow === 'done'}
        <div class="flex flex-col gap-3 text-sm">
          {#if view.succeeded}
            <p class="text-foreground">Logged in successfully.</p>
          {:else}
            <p class="text-destructive">Login failed{view.error ? `: ${view.error}` : '.'}</p>
          {/if}
          <button class="bg-primary text-primary-foreground hover:bg-primary/85 self-end rounded-md px-3 py-2 font-medium" onclick={close}>Done</button>
        </div>
      {/if}
    </div>
  </div>
{/if}
