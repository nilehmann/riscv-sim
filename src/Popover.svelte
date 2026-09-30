<script lang="ts">
  import type { Snippet } from "svelte";

  // Floating card attached to the right of a code row, clamped to the viewport.
  let {
    anchor,
    pinned = false,
    onenter,
    onleave,
    children,
  }: {
    /** Viewport point the popover attaches to: right edge / top of the row. */
    anchor: { x: number; y: number };
    /** Pinned popovers stay open regardless of the pointer until closed. */
    pinned?: boolean;
    /** The pointer entering/leaving the popover keeps it open / lets it close. */
    onenter: () => void;
    onleave: () => void;
    children: Snippet;
  } = $props();

  let w = $state(0);
  let h = $state(0);
  const MARGIN = 8;
  const left = $derived(
    Math.max(MARGIN, Math.min(anchor.x + MARGIN, window.innerWidth - w - MARGIN)),
  );
  const top = $derived(
    Math.max(MARGIN, Math.min(anchor.y, window.innerHeight - h - MARGIN)),
  );
</script>

<div
  class="popover"
  class:pinned
  role="tooltip"
  onmouseenter={onenter}
  onmouseleave={onleave}
  bind:offsetWidth={w}
  bind:offsetHeight={h}
  style="left:{left}px; top:{top}px"
>
  {@render children()}
</div>

<style>
  .popover {
    position: fixed;
    z-index: 1000;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
    padding: 12px 14px;
    font-family: var(--mono);
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .popover.pinned {
    border-color: var(--blue);
  }
</style>
