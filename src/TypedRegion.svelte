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

  const title = $derived.by(() => {
    const t = region.type;
    const elem = t.kind === "array" ? t.elem : t;
    return { decl: typeName(t), size: `sizeof(${typeName(elem)}) = ${region.size / (t.kind === "array" ? t.len : 1)}` };
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
    <span><b>{region.name}</b> : {title.decl}</span>
    <span>@ {fmtAddr(region.addr)}</span>
    <span>{title.size}</span>
  </div>
  <div class="region-scroll">
    <div class="region-grid" style="grid-template-rows:{rows}">
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
              <span class="slot-addr" style="grid-row:1;grid-column:{i + 1 + picker}">{fmtAddr(piece.addr)}</span>
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
  }
  .region-grid {
    display: grid;
    width: max-content;
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
