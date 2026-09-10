<script lang="ts">
  import { tick } from 'svelte';
  let {
    title,
    disabled,
    onsave,
  }: {
    title: string;
    disabled: boolean;
    onsave: (title: string) => Promise<void>;
  } = $props();
  let editing = $state(false);
  let draft = $state('');
  let saving = $state(false);
  let error = $state('');
  let input = $state<HTMLInputElement>();
  let button = $state<HTMLButtonElement>();
  async function edit() {
    draft = title;
    error = '';
    editing = true;
    await tick();
    input?.focus();
  }
  async function finish(restoreFocus = false) {
    if (!editing || saving) return;
    const next = draft.trim() || 'Untitled';
    saving = true;
    error = '';
    try {
      if (next !== title) await onsave(next);
      editing = false;
      if (restoreFocus) {
        await tick();
        button?.focus();
      }
    } catch (e) {
      error = (e as Error).message;
    } finally {
      saving = false;
    }
  }
  async function cancel() {
    editing = false;
    await tick();
    button?.focus();
  }
</script>

<div class="title-edit">
  {#if editing}
    <input
      class="page-title-input"
      aria-label="Page title"
      aria-invalid={!!error}
      bind:this={input}
      bind:value={draft}
      maxlength="200"
      placeholder="Untitled"
      disabled={saving}
      onblur={() => finish()}
      onkeydown={(event) => {
        if (event.isComposing) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          void finish(true);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          void cancel();
        }
      }}
    />
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  {:else}
    <button
      class="page-title"
      aria-label="Rename page"
      {disabled}
      bind:this={button}
      onclick={edit}
    >
      <h1>{title}</h1>
    </button>
  {/if}
</div>
