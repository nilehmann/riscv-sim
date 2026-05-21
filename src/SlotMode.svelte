<script lang="ts">
  interface Props {
    mode: 'word' | 'halfword' | 'byte';
    showWord?: boolean;
    disabled?: boolean;
    transparent?: boolean;
    onchange: (mode: 'word' | 'halfword' | 'byte') => void;
  }
  let { mode, showWord = true, disabled = false, transparent = false, onchange }: Props = $props();

  let open = $state(false);
  let containerEl = $state<HTMLElement | null>(null);
  let triggerEl = $state<HTMLButtonElement | null>(null);
  let dropTop = $state(0);
  let dropLeft = $state(0);

  const label = $derived(mode === 'word' ? 'w' : mode === 'halfword' ? 'h' : 'b');

  function toggle() {
    if (!open && triggerEl) {
      const r = triggerEl.getBoundingClientRect();
      dropTop = r.bottom + 2;
      dropLeft = r.left;
    }
    open = !open;
  }

  function pick(m: 'word' | 'halfword' | 'byte') {
    onchange(m);
    open = false;
  }

  $effect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!containerEl?.contains(e.target as Node)) open = false;
    }
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  });
</script>

<div class="slot-picker" class:transparent bind:this={containerEl}>
  <button class="trigger" {disabled} bind:this={triggerEl} onclick={toggle}>{label}</button>
  {#if open}
    <div class="dropdown" style="top:{dropTop}px;left:{dropLeft}px">
      {#if showWord}
        <button class:active={mode === 'word'} onclick={() => pick('word')}>w</button>
      {/if}
      <button class:active={mode === 'halfword'} onclick={() => pick('halfword')}>h</button>
      <button class:active={mode === 'byte'} onclick={() => pick('byte')}>b</button>
    </div>
  {/if}
</div>

<style>
  .slot-picker { position: relative; display: inline-block; }
  .trigger {
    font-size: 10px;
    padding: 1px 3px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: var(--surface);
    color: var(--text-faint);
    cursor: pointer;
    font-family: var(--mono);
    line-height: 1;
  }
  .trigger::after {
    content: '';
    display: inline-block;
    border-left: 3px solid transparent;
    border-right: 3px solid transparent;
    border-top: 4px solid currentColor;
    vertical-align: middle;
    margin-left: 3px;
  }
  .transparent .trigger { background: transparent; }
  .trigger:disabled { opacity: 0.4; cursor: default; }
  .dropdown {
    position: fixed;
    z-index: 1000;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: var(--surface);
    display: flex;
    flex-direction: column;
    min-width: 24px;
    box-shadow: 0 2px 6px rgba(0,0,0,0.12);
  }
  .dropdown button {
    font-size: 10px;
    padding: 2px 6px;
    border: none;
    background: none;
    color: var(--text-faint);
    cursor: pointer;
    font-family: var(--mono);
    text-align: left;
    white-space: nowrap;
  }
  .dropdown button:hover { background: var(--surface2); }
  .dropdown button.active { color: var(--text); }
</style>
