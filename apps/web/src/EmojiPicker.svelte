<script lang="ts">
  import { FileText, Trash2 } from '@lucide/svelte';
  import { onDestroy, onMount } from 'svelte';
  import dataSource from 'emoji-picker-element-data/en/emojibase/data.json?url';
  let {
    value = null,
    onchange,
    disabled = false,
  }: {
    value?: string | null;
    onchange: (emoji: string | null) => void | Promise<void>;
    disabled?: boolean;
  } = $props();
  let details: HTMLDetailsElement;
  let host: HTMLDivElement;
  let loading = $state(false);
  let failed = $state(false);
  let mounted = false;
  let destroyed = false;
  onDestroy(() => {
    destroyed = true;
  });
  onMount(() => {
    function dismissOutside(event: PointerEvent) {
      if (details.open && !event.composedPath().includes(details)) {
        details.open = false;
      }
    }
    function dismissEscape(event: KeyboardEvent) {
      if (details.open && event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        details.open = false;
        details.querySelector('summary')?.focus();
      }
    }
    document.addEventListener('pointerdown', dismissOutside, true);
    document.addEventListener('keydown', dismissEscape, true);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside, true);
      document.removeEventListener('keydown', dismissEscape, true);
    };
  });
  async function openPicker() {
    if (disabled) {
      details.open = false;
      return;
    }
    if (!details.open || mounted || loading) return;
    loading = true;
    failed = false;
    try {
      const { default: Picker } = await import('emoji-picker-element/picker');
      if (destroyed) return;
      const picker = new Picker({ dataSource });
      picker.addEventListener('emoji-click', (event) => {
        if (!disabled && event.detail.unicode) pick(event.detail.unicode);
      });
      // The picker exposes these customizations through shadow-root styles.
      const style = document.createElement('style');
      style.textContent = `
        .picker { border: 0; }
        .search-row { padding-inline-end: 44px; }
        .skintone-list { inset-inline-end: 44px; }
        .favorites { display: none; }
        .emoji-menu {
          grid-template-columns: repeat(var(--num-columns), minmax(0, 1fr));
        }
        .emoji-menu .emoji { width: 100%; max-width: var(--total-emoji-size); justify-self: center; }
      `;
      picker.shadowRoot?.appendChild(style);
      host.appendChild(picker);
      mounted = true;
    } catch {
      failed = true;
    } finally {
      loading = false;
    }
  }
  function pick(emoji: string | null) {
    void onchange(emoji);
    details.open = false;
    details.querySelector('summary')?.focus();
  }
</script>

<details class="emoji-picker" bind:this={details} ontoggle={openPicker}>
  <summary
    aria-label="Choose page emoji"
    aria-disabled={disabled}
    onclick={(event) => {
      if (disabled) event.preventDefault();
    }}
    >{#if value}<span class="page-emoji" aria-hidden="true">{value}</span
      >{:else}<FileText size={20} />{/if}</summary
  >
  <div class="emoji-popover">
    <div bind:this={host}></div>
    {#if loading}<span role="status">Loading…</span>{/if}
    {#if failed}<button type="button" onclick={openPicker}
        >Retry loading emojis</button
      >{/if}
    <button
      type="button"
      class="remove-emoji"
      aria-label="Remove emoji"
      title="Remove emoji"
      {disabled}
      onclick={() => pick(null)}><Trash2 size={18} /></button
    >
  </div>
</details>
