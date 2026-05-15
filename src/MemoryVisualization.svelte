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
    let val = 0;
    for (let b = 0; b < region.elementSize; b++) {
      val |= ((sim.currentStep?.mem.get(addr + b) ?? 0) & 0xff) << (b * 8);
    }
    const mask =
      region.elementSize === 1 ? 0xff
      : region.elementSize === 2 ? 0xffff
      : 0xffffffff;
    return val & mask;
  }
</script>

{#if sim.program?.memoryRegions?.length}
  <div class="memory-panel">
    {#each sim.program.memoryRegions as region}
      <div class="region-card">
        <div class="region-slots">
          {#each region.elements as _, i}
            {@const elemAddr = region.addr + i * region.elementSize}
            <div class="region-slot" class:hi={isHighlighted(elemAddr)}>
              <div class="slot-meta">
                <span class="slot-addr">{hx(elemAddr)}</span>
                <span class="slot-idx">[{i}]</span>
              </div>
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
.region-slots {
    display: flex;
    flex-direction: row;
  }
  .region-slot {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    padding: 6px 10px;
    border-right: 1px solid var(--border);
    background: var(--surface);
    position: relative;
    min-width: 140px;
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
  .slot-meta {
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
    margin-bottom: 4px;
    gap: 8px;
    border-bottom: 1px solid var(--border);
    padding-bottom: 4px;
  }
  .slot-addr {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text-faint);
  }
  .slot-idx {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text-faint);
  }
</style>
