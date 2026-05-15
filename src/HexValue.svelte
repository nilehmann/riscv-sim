<script lang="ts">
  import { hx } from "./assembler";

  let { value, elementSize = 4, faint = false }: { value: number; elementSize?: 1 | 2 | 4; faint?: boolean } =
    $props();

  const unsigned = $derived(value >>> 0);
  const signed = $derived.by(() => {
    const shift = (4 - elementSize) * 8;
    return (unsigned << shift) >> shift;
  });

  let show = $state(false);
  let x = $state(0);
  let y = $state(0);
  let tooltipEl = $state<HTMLElement | null>(null);

  function enter(e: MouseEvent) {
    show = true;
    position(e);
  }
  function move(e: MouseEvent) {
    if (show) position(e);
  }
  function leave() {
    show = false;
  }

  function position(e: MouseEvent) {
    const tw = tooltipEl?.offsetWidth ?? 160;
    const th = tooltipEl?.offsetHeight ?? 56;
    x = Math.min(e.clientX + 14, window.innerWidth - tw - 8);
    y = Math.min(e.clientY + 14, window.innerHeight - th - 8);
  }
</script>

<span
  class="hex-val"
  class:hex-faint={faint}
  onmouseenter={faint ? undefined : enter}
  onmousemove={faint ? undefined : move}
  onmouseleave={faint ? undefined : leave}
>{hx(value, elementSize)}</span>

{#if show && !faint}
  <div
    class="hex-tooltip"
    bind:this={tooltipEl}
    style="left:{x}px;top:{y}px"
  >
    <div class="tt-row">
      <span class="tt-label">unsigned</span>
      <span class="tt-num">{unsigned}</span>
    </div>
    <div class="tt-row">
      <span class="tt-label">signed</span>
      <span class="tt-num">{signed}</span>
    </div>
  </div>
{/if}

<style>
  .hex-val {
    font-family: var(--mono);
    font-size: 16px;
    color: var(--text);
    cursor: default;
    text-decoration: underline dotted currentColor;
    text-underline-offset: 2px;
  }
  .hex-faint {
    color: var(--text-faint);
    text-decoration: none;
    pointer-events: none;
    opacity: 0.4;
  }
  .hex-tooltip {
    position: fixed;
    z-index: 9999;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 12px;
    pointer-events: none;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.15);
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 160px;
  }
  .tt-row {
    display: flex;
    justify-content: space-between;
    gap: 20px;
    font-family: var(--mono);
    font-size: 13px;
  }
  .tt-label {
    color: var(--text-faint);
  }
  .tt-num {
    color: var(--text);
    font-weight: 600;
  }
</style>
