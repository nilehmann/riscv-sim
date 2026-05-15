<script lang="ts">
  import type { MemoryRegion } from "./types";
  import { sim, ui } from "./state.svelte";
  import { hx } from "./assembler";
  import HexValue from "./HexValue.svelte";

  function isHighlighted(addr: number): boolean {
    const wordAddr = addr & ~3;
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

  function readBytes(mem: Map<number, number>, addr: number, bytes: 1 | 2 | 4): number {
    let val = 0;
    for (let i = 0; i < bytes; i++) val |= ((mem.get(addr + i) ?? 0) & 0xff) << (i * 8);
    return val;
  }

  function subSlots(addr: number, nativeBytes: 1 | 2 | 4, mode: 'halfword' | 'byte') {
    const subSize: 1 | 2 = mode === 'byte' ? 1 : 2;
    const count = nativeBytes / subSize;
    return Array.from({ length: count }, (_, i) => ({
      addr: addr + i * subSize,
      size: subSize as 1 | 2,
    }));
  }

  function slotMode(key: string, def: 'word' | 'halfword' | 'byte'): 'word' | 'halfword' | 'byte' {
    return ui.slotViewMode.get(key) ?? def;
  }

  function setSlotMode(key: string, mode: 'word' | 'halfword' | 'byte') {
    const next = new Map(ui.slotViewMode);
    next.set(key, mode);
    ui.slotViewMode = next;
  }
</script>

{#if sim.program?.memoryRegions?.length}
  <div class="memory-panel">
    {#each sim.program.memoryRegions as region}
      <div class="region-card">
        <div class="region-slots">
          {#each region.elements as _, i}
            {@const elemAddr = region.addr + i * region.elementSize}
            {@const nativeSize = region.elementSize}
            {@const key = `mem-${region.addr}-${i}`}
            {@const defaultMode = nativeSize === 4 ? 'word' : nativeSize === 2 ? 'halfword' : 'byte'}
            {@const mode = slotMode(key, defaultMode)}
            <div class="region-slot" class:hi={isHighlighted(elemAddr)}>
              <div class="slot-meta">
                {#if nativeSize > 1}
                  <select
                    class="slot-select"
                    value={mode}
                    onchange={(e) => setSlotMode(key, e.currentTarget.value as 'word' | 'halfword' | 'byte')}
                  >
                    {#if nativeSize === 4}<option value="word">w</option>{/if}
                    <option value="halfword">h</option>
                    <option value="byte">b</option>
                  </select>
                {/if}
                {#if mode === defaultMode}
                  <span class="slot-addr">{hx(elemAddr)}</span>
                  <span class="slot-idx">[{i}]</span>
                {:else}
                  {#each subSlots(elemAddr, nativeSize, mode) as sub}
                    <div class="sub-slot">
                      <span class="sub-addr">{hx(sub.addr)}</span>
                      <HexValue
                        value={readBytes(sim.currentStep?.mem ?? new Map(), sub.addr, sub.size)}
                        elementSize={sub.size}
                      />
                    </div>
                  {/each}
                {/if}
              </div>
              {#if mode === defaultMode}
                <HexValue value={readElement(region, i)} elementSize={nativeSize} />
              {/if}
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
    align-items: flex-start;
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
  .slot-select {
    font-size: 10px;
    padding: 1px 2px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: var(--surface);
    color: var(--text-faint);
    cursor: pointer;
  }
  .sub-slot {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
  }
  .sub-addr {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-faint);
  }
</style>
