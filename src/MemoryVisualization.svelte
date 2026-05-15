<script lang="ts">
  import type { MemoryRegion } from "./types";
  import { sim } from "./state.svelte";
  import { hx } from "./assembler";
  import HexValue from "./HexValue.svelte";

  function isHighlighted(elemAddr: number): boolean {
    const wordAddr = elemAddr & ~3;
    return sim.currentStep?.hiSlots.includes(wordAddr) ?? false;
  }

  function readElement(region: MemoryRegion, i: number): number {
    const addr = region.addr + i * region.elementSize;
    const raw = sim.currentStep?.mem.get(addr) ?? 0;
    const mask =
      region.elementSize === 1 ? 0xff
      : region.elementSize === 2 ? 0xffff
      : 0xffffffff;
    return raw & mask;
  }
</script>

{#if sim.program?.memoryRegions?.length}
  <div class="memory-panel">
    {#each sim.program.memoryRegions as region}
      <div class="region-card">
        <div class="region-header">{hx(region.addr)}</div>
        <div class="region-slots">
          {#each region.elements as _, i}
            {@const elemAddr = region.addr + i * region.elementSize}
            <div class="region-slot" class:hi={isHighlighted(elemAddr)}>
              <span class="slot-idx">[{i}]</span>
              <HexValue value={readElement(region, i)} elementSize={region.elementSize} />
            </div>
          {/each}
        </div>
      </div>
    {/each}
  </div>
{/if}

<style>
  .memory-panel {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    padding: 16px 24px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .region-card {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border);
  }
  .region-header {
    font-family: var(--mono);
    font-size: 13px;
    color: var(--text-faint);
    padding: 4px 8px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }
  .region-slots {
    display: flex;
    flex-direction: row;
  }
  .region-slot {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 6px 10px;
    border-right: 1px solid var(--border);
    background: var(--surface);
    position: relative;
    min-width: 80px;
  }
  .region-slot:last-child {
    border-right: none;
  }
  .region-slot::after {
    content: "";
    position: absolute;
    inset: 0;
    background: var(--orange-dim);
    opacity: 0;
    pointer-events: none;
  }
  @keyframes slot-flash {
    0% { opacity: 1; }
    100% { opacity: 0; }
  }
  .region-slot.hi::after {
    animation: slot-flash 0.8s ease-out forwards;
  }
  .slot-idx {
    font-family: var(--mono);
    font-size: 13px;
    color: var(--text-faint);
    margin-bottom: 2px;
  }
</style>
