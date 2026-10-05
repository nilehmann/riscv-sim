<script lang="ts">
  import type { ResolvedRegion } from "./types";
  import { sim, ui } from "./state.svelte";
  import { fmtAddr } from "./types";
  import { typeName, leavesOf } from "./ctypes";
  import type { TypedNode } from "./ctypes";
  import { layoutRegion, isAccessed } from "./regionLayout";
  import { subSlots, readWritten } from "./memUtils";
  import HexValue from "./HexValue.svelte";
  import SlotMode from "./SlotMode.svelte";

  let { region }: { region: ResolvedRegion } = $props();

  const open = $derived(ui.openCards.get(region.name) ?? new Set<string>());

  /** Toggles one card only, so the cards inside it keep their state. */
  function toggle(path: string) {
    const set = new Set(open);
    if (set.has(path)) set.delete(path);
    else set.add(path);
    const next = new Map(ui.openCards);
    next.set(region.name, set);
    ui.openCards = next;
  }
  const layout = $derived(layoutRegion(region.root, open, fmtAddr));
  const access = $derived(sim.currentStep?.access);

  // ── Pointer arrows ──
  // Registers toggled as pointers whose value is inside the region (or one
  // past its end), grouped by address.
  const pointers = $derived.by(() => {
    const regs = sim.currentStep?.regs ?? {};
    const byAddr = new Map<number, string[]>();
    for (const reg of sim.displayRegs.map((r) => r.key).filter((k) => ui.pointerRegs.has(k))) {
      const v = regs[reg];
      if (v === undefined || v < BigInt(region.addr) || v > BigInt(region.addr + region.size)) continue;
      const a = Number(v);
      byAddr.set(a, [...(byAddr.get(a) ?? []), reg]);
    }
    return [...byAddr].map(([addr, regs]) => ({ addr, regs }));
  });
  const written = $derived(
    new Set((sim.currentStep?.hiReg ?? []).map((r) => sim.isa.regs.aliases[r] ?? r)),
  );

  let laneEl = $state<HTMLElement | null>(null);
  let gridEl = $state<HTMLElement | null>(null);
  /**
   * Horizontal position of each arrow, by its first register, measured after
   * layout. Until it is re-measured an arrow keeps its old position, so it
   * slides to the new one.
   */
  let arrowX = $state<Map<string, number>>(new Map());

  /** Left edge of the byte at addr: inside the narrowest slot or piece holding it. */
  function byteX(addr: number): number | null {
    if (!gridEl || !laneEl) return null;
    const origin = laneEl.getBoundingClientRect().left;
    if (addr === region.addr + region.size) return gridEl.getBoundingClientRect().right - origin;
    let best: { el: Element; start: number; size: number } | null = null;
    for (const el of gridEl.querySelectorAll("[data-ptr-addr]")) {
      const start = Number((el as HTMLElement).dataset.ptrAddr);
      const size = Number((el as HTMLElement).dataset.ptrSize);
      if (addr >= start && addr < start + size && (!best || size < best.size)) best = { el, start, size };
    }
    if (!best) return null;
    const r = best.el.getBoundingClientRect();
    return r.left - origin + ((addr - best.start) / best.size) * r.width;
  }

  function measure() {
    const next = new Map<number, number>();
    for (const p of pointers) {
      const x = byteX(p.addr);
      if (x !== null) next.set(p.regs[0]!, x);
    }
    arrowX = next;
  }

  $effect(() => {
    // Anything that can move or resize the slots.
    void [pointers, ui.slotViewMode, ui.openCards, sim.currentStep];
    if (!gridEl) return;
    const id = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(id);
  });

  $effect(() => {
    if (!gridEl) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(gridEl);
    return () => ro.disconnect();
  });

  const rows = $derived(
    ["auto", ...(layout.labelRow ? ["auto"] : []), ...Array(layout.footerRows).fill("30px")].join(" "),
  );

  const read = (addr: number, size: number): bigint =>
    readWritten(sim.currentStep?.mem ?? new Map(), addr, size) ?? 0n;

  /** The outermost card containing an accessed leaf gets an orange border. */
  const accessedCard = (n: TypedNode) => leavesOf(n).some((l) => isAccessed(l, access));

  const slotKey = (leaf: TypedNode) => `mem-${region.name}-${leaf.path}`;
  function slotMode(leaf: TypedNode): number {
    return ui.slotViewMode.get(slotKey(leaf)) ?? leaf.size;
  }
  function setSlotMode(leaf: TypedNode, mode: number) {
    const next = new Map(ui.slotViewMode);
    next.set(slotKey(leaf), mode);
    ui.slotViewMode = next;
  }
</script>

<div class="region">
  <div class="region-title">
    <span><b>{region.name}</b> : {typeName(region.type)}</span>
  </div>
  <div class="region-scroll">
    <!-- Kept while any register is shown as a pointer, so the region doesn't jump. -->
    {#if sim.displayRegs.some((r) => ui.pointerRegs.has(r.key))}
      <div class="arrow-lane" bind:this={laneEl}>
        <!-- Keyed by the first register so an arrow slides when its register moves. -->
        {#each pointers as p (p.regs[0])}
          {@const x = arrowX.get(p.regs[0]!)}
          {#if x !== undefined}
            <div class="ptr-arrow" style="left:{x}px">
              {#key sim.cur}
                <span class="ptr-label" class:hi={p.regs.some((r) => written.has(r))}>{p.regs.join(" ")}</span>
              {/key}
              <span class="ptr-shaft"></span>
              <span class="ptr-head"></span>
            </div>
          {/if}
        {/each}
      </div>
    {/if}
    <div class="region-grid" style="grid-template-rows:{rows}" bind:this={gridEl}>
      {#each layout.leaves as cell (cell.leaf.path)}
        {@const leaf = cell.leaf}
        {@const size = leaf.size as 1 | 2 | 4 | 8}
        {@const mode = slotMode(leaf)}
        {@const picker = !leaf.pad && size > 1 ? 1 : 0}
        {@const pieces = leaf.pad || mode === size ? [{ addr: leaf.addr, size }] : subSlots(leaf.addr, size, mode as 1 | 2 | 4)}
        <div
          class="region-slot"
          class:pad={leaf.pad}
          class:narrow={leaf.pad || size === 1}
          class:first={cell.col === 1}
          class:outer-start={cell.outerStart}
          class:inner-start={cell.innerStart}
          class:hi={isAccessed(leaf, access)}
          style="grid-row:1;grid-column:{cell.col}"
          data-ptr-addr={pieces.length === 1 ? leaf.addr : undefined}
          data-ptr-size={pieces.length === 1 ? leaf.size : undefined}
        >
          <!-- Same grid in every mode, so addresses and values line up across slots. -->
          <div class="slot-grid" style="grid-template-columns:{picker ? "auto " : ""}repeat({pieces.length}, auto)">
            <div class="meta-line"></div>
            {#if picker}
              <div class="mode-cell">
                <SlotMode {mode} {size} onchange={(m) => setSlotMode(leaf, m)} />
              </div>
            {/if}
            {#each pieces as piece, i}
              <span
                class="slot-addr"
                style="grid-row:1;grid-column:{i + 1 + picker}"
                data-ptr-addr={pieces.length > 1 ? piece.addr : undefined}
                data-ptr-size={pieces.length > 1 ? piece.size : undefined}
              >{fmtAddr(piece.addr)}</span>
              <!-- A whole value also extends under the size picker. -->
              <div class="val-cell" style="grid-row:2;grid-column:{pieces.length === 1 ? "1 / -1" : i + 1 + picker}">
                {#if leaf.pad}
                  <span class="pad-val">··</span>
                {:else}
                  <HexValue
                    value={read(piece.addr, piece.size)}
                    elementSize={piece.size as 1 | 2 | 4 | 8}
                    path={leaf.path}
                    offset={piece.addr - region.addr}
                  />
                {/if}
              </div>
            {/each}
          </div>
        </div>
        {#if cell.labelled}
          <div class="leaf-label" class:pad-label={leaf.pad} style="grid-row:2;grid-column:{cell.col}">
            {leaf.label}
          </div>
        {/if}
      {/each}
      {#each layout.cards as card (card.node.path)}
        <div
          class="card"
          class:inner={!card.outer}
          class:accessed={card.outer && accessedCard(card.node)}
          style="grid-row:1 / {card.lastRow + 1};grid-column:{card.col} / span {card.span};z-index:{1 + card.node.depth}"
        >
          <button class="toggle" aria-expanded={card.open} onclick={() => toggle(card.node.path)}>
            <span class="chev" aria-hidden="true">{card.open ? "▾" : "▸"}</span>{card.node.label}
          </button>
          <span class="where">{card.where}</span>
        </div>
      {/each}
    </div>
  </div>
</div>

<style>
  .region {
    display: flex;
    flex-direction: column;
    min-width: 0;
    max-width: 100%;
  }
  .region-title {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text-dim);
    margin-bottom: 10px;
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
  }
  .region-title b {
    color: var(--text);
    font-weight: 600;
  }
  .region-scroll {
    overflow-x: auto;
    /* Room for an arrow head at either edge without moving the slots. */
    margin-inline: -8px;
    padding-inline: 8px;
  }
  .region-grid {
    display: grid;
    width: max-content;
  }

  /* ── Pointer arrows ── */
  .arrow-lane {
    position: relative;
    height: 42px;
    min-width: 100%;
  }
  .ptr-arrow {
    position: absolute;
    bottom: 0;
    /* The head's tip sits at `left`; the label extends to the right. */
    transform: translateX(-6px);
    transition: left 0.45s ease;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    font-family: var(--mono);
    font-size: 14px;
    color: var(--purple);
    white-space: nowrap;
    pointer-events: none;
  }
  .ptr-label {
    padding: 0 4px 0 2px;
    border-radius: 3px;
  }
  @keyframes ptr-flash {
    0% { background: var(--purple-dim); }
    100% { background: transparent; }
  }
  .ptr-label.hi {
    animation: ptr-flash 0.8s ease-out forwards;
  }
  .ptr-shaft {
    margin-left: 5px;
    width: 2px;
    height: 10px;
    background: currentColor;
  }
  .ptr-head {
    width: 0;
    height: 0;
    border-left: 6px solid transparent;
    border-right: 6px solid transparent;
    border-top: 9px solid currentColor;
  }

  /* ── Value slots ── */
  .region-slot {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    padding: 6px 10px;
    background: var(--surface);
    position: relative;
    min-width: 120px;
    gap: 4px;
    border: 1px solid var(--border);
    border-left-width: 0;
  }
  .region-slot.narrow {
    min-width: 96px;
  }
  .region-slot.first {
    border-left-width: 1px;
  }
  .region-slot.inner-start {
    border-left: 1px dashed var(--text-faint);
  }
  .region-slot.pad {
    background-image: repeating-linear-gradient(
      135deg,
      color-mix(in srgb, var(--text) 8%, transparent) 0 4px,
      transparent 4px 8px
    );
  }
  .pad-val {
    font-family: var(--mono);
    font-size: 13px;
    color: var(--text-faint);
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
  .slot-grid {
    display: grid;
    grid-template-rows: 24px 20px;
    column-gap: 8px;
    row-gap: 4px;
    width: 100%;
  }
  .meta-line {
    grid-row: 1;
    grid-column: 1 / -1;
    border-bottom: 1px solid var(--border);
  }
  .mode-cell {
    grid-row: 1;
    grid-column: 1;
    display: flex;
    align-items: center;
    padding-bottom: 1px;
  }
  .slot-addr {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text-faint);
    white-space: nowrap;
    align-self: center;
    padding-bottom: 1px;
  }
  .val-cell {
    display: flex;
    align-items: center;
    justify-content: flex-end;
  }

  /* ── Leaf names ── */
  .leaf-label {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--blue);
    text-align: center;
    padding: 5px 4px 3px;
    white-space: nowrap;
  }
  .leaf-label.pad-label {
    color: var(--text-faint);
  }

  /* ── Cards ── */
  .card {
    border: 1.5px solid var(--text-faint);
    display: flex;
    align-items: flex-end;
    gap: 8px;
    padding: 0 8px 5px;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text-faint);
    pointer-events: none;
    min-width: 0;
  }
  .card.inner {
    border: 1px dashed var(--text-faint);
  }
  .card.accessed {
    border-color: var(--orange);
  }
  .toggle {
    pointer-events: auto;
    background: none;
    border: 0;
    border-radius: 3px;
    cursor: pointer;
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 600;
    color: var(--text-dim);
    padding: 2px 4px;
    margin-left: -4px;
    display: inline-flex;
    gap: 4px;
    align-items: center;
    white-space: nowrap;
  }
  .toggle:hover {
    background: var(--blue-dim);
    color: var(--blue);
  }
  .toggle:focus-visible {
    outline: 2px solid var(--blue);
  }
  .chev {
    font-size: 10px;
    width: 10px;
  }
  .where {
    margin-left: auto;
    white-space: nowrap;
  }
</style>
