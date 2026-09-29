<script lang="ts">
  import type { Instr, SourceInstr } from "./types";
  import type { Field } from "./encoder";
  import { encodeDetailed, wordBytes } from "./encoder";
  import { hx } from "./assembler";
  import InstrView from "./InstrView.svelte";
  import { _ } from "svelte-i18n";

  let {
    instr,
    addr,
    instrHtml,
    pseudo,
    labels,
    anchor,
    pinned,
    onenter,
    onleave,
    onclose,
  }: {
    instr: Instr;
    addr: number;
    instrHtml: string;
    /** Source pseudo-instruction this instruction was expanded from, if any. */
    pseudo: SourceInstr | null;
    labels: Record<string, number>;
    /** Viewport point the popover attaches to: right edge / top of the row. */
    anchor: { x: number; y: number };
    /** The pointer entering/leaving the popover keeps it open / lets it close. */
    onenter: () => void;
    onleave: () => void;
    /** Pinned popovers stay open regardless of the pointer until closed. */
    pinned: boolean;
    onclose: () => void;
  } = $props();

  const enc = $derived(encodeDetailed(instr));
  const bytes = $derived(wordBytes(enc.word));
  const BITS = Array.from({ length: 32 }, (_, i) => 31 - i);

  // Cross-highlighting between bytes, bits, fields and immediate pieces.
  let hoverField = $state<string | null>(null);
  let hoverByte = $state<number | null>(null);

  function fieldOf(bit: number): Field {
    return enc.fields.find((f) => bit >= f.lo && bit <= f.hi)!;
  }
  function bitCol(bit: number): number {
    return 32 - bit;
  }
  function span(f: Field): number {
    return f.hi - f.lo + 1;
  }
  function bin(v: number, width: number): string {
    return v.toString(2).padStart(width, "0");
  }
  // Label fits under the field when it is no wider than the field's columns.
  // Keep in sync with .enc-grid column width and .field-name font size.
  const BIT_COL_PX = 22;
  const LABEL_CHAR_PX = 13 * 0.6;
  function fitsLabel(f: Field): boolean {
    return f.name.length * LABEL_CHAR_PX <= span(f) * BIT_COL_PX - 4;
  }

  // ─── Positioning: to the right of the row, clamped to the viewport ──────
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
  class="enc-popover"
  class:pinned
  role="tooltip"
  onmouseenter={onenter}
  onmouseleave={onleave}
  bind:offsetWidth={w}
  bind:offsetHeight={h}
  style="left:{left}px; top:{top}px"
>
  <div class="enc-header">
    <span class="enc-instr">{@html instrHtml}</span>
    <span class="enc-format">{$_("encoding.format", { values: { format: enc.format } })}</span>
    {#if pinned}
      <button class="enc-close" onclick={onclose} aria-label={$_("encoding.close")}>✕</button>
    {:else}
      <span class="enc-hint">{$_("encoding.pin_hint")}</span>
    {/if}
  </div>
  {#if pseudo}
    <div class="enc-pseudo">
      {$_("encoding.expanded_from")} <InstrView si={pseudo} {labels} />
    </div>
  {/if}

  <div class="enc-grid">
    <!-- Bytes in memory: highest address on the left so bits read MSB→LSB -->
    {#each [3, 2, 1, 0] as k}
      <span
        class="byte-addr"
        class:hover={hoverByte === k}
        style="grid-row:1; grid-column:{(3 - k) * 8 + 1} / span 8"
      >{hx(addr + k)}</span>
      <span
        class="byte-val"
        class:hover={hoverByte === k}
        style="grid-row:2; grid-column:{(3 - k) * 8 + 1} / span 8"
        role="presentation"
        onmouseenter={() => (hoverByte = k)}
        onmouseleave={() => (hoverByte = null)}
      >{bytes[k]!.toString(16).toUpperCase().padStart(2, "0")}</span>
    {/each}

    <!-- The 32 bits, colored by field -->
    {#each BITS as bit}
      {@const f = fieldOf(bit)}
      <span
        class="bit k-{f.kind}"
        class:fstart={bit === f.hi}
        class:hover={hoverField === f.name || hoverByte === bit >> 3}
        style="grid-row:3; grid-column:{bitCol(bit)}"
        data-tooltip="bit {bit}"
        role="presentation"
        onmouseenter={() => (hoverField = f.name)}
        onmouseleave={() => (hoverField = null)}
      >{(enc.word >>> bit) & 1}</span>
    {/each}

    <!-- Field brackets and names -->
    {#each enc.fields as f}
      <span
        class="field-name k-{f.kind}"
        class:hover={hoverField === f.name}
        style="grid-row:4; grid-column:{bitCol(f.hi)} / span {span(f)}"
        role="presentation"
        onmouseenter={() => (hoverField = f.name)}
        onmouseleave={() => (hoverField = null)}
      >{fitsLabel(f) ? f.name : ""}</span>
    {/each}
  </div>

  <!-- One row per field, same order as the bits -->
  <div class="enc-table">
    {#each enc.fields as f}
      <div
        class="enc-row"
        class:hover={hoverField === f.name}
        role="presentation"
        onmouseenter={() => (hoverField = f.name)}
        onmouseleave={() => (hoverField = null)}
      >
        <span class="t-name k-{f.kind}">{f.name}</span>
        <span class="t-bits">{bin(f.value, span(f))}</span>
        <span class="t-note">{f.note}</span>
      </div>
    {/each}
  </div>

  <!-- Split immediates: show how the pieces are put back together -->
  {#if enc.imm && enc.imm.parts.length > 1}
    <div class="enc-imm">
      <span class="imm-label">imm =</span>
      {#each enc.imm.parts as p, i}
        {#if i > 0}<span class="imm-sep">·</span>{/if}
        {#if p.field}
          <span
            class="imm-part"
            class:hover={hoverField === p.field}
            data-tooltip={p.field}
            role="presentation"
            onmouseenter={() => (hoverField = p.field)}
            onmouseleave={() => (hoverField = null)}
          >{p.bits}</span>
        {:else}
          <span class="imm-implicit" data-tooltip={$_("encoding.implicit_zero")}>{p.bits}</span>
        {/if}
      {/each}
      <span class="imm-label">= {enc.imm.value}</span>
    </div>
  {/if}
</div>

<style>
  .enc-popover {
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

  /* Field kind colors, matching the syntax highlighting */
  .k-opcode { --k: var(--red); --k-dim: var(--red-dim); }
  .k-funct { --k: var(--purple); --k-dim: var(--purple-dim); }
  .k-reg { --k: var(--green); --k-dim: var(--green-dim); }
  .k-imm { --k: var(--orange); --k-dim: var(--orange-dim); }

  .enc-header {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 18px;
  }
  .enc-instr {
    flex: 1;
    white-space: pre;
  }
  .enc-pseudo {
    font-size: 15px;
    color: var(--text-dim);
    margin-top: -6px;
    white-space: pre;
  }
  .enc-format,
  .enc-hint {
    font-size: 13px;
    color: var(--text-faint);
  }
  .enc-popover.pinned {
    border-color: var(--blue);
  }
  .enc-close {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-faint);
    font-size: 16px;
    line-height: 1;
  }
  .enc-close:hover {
    color: var(--text);
  }

  .enc-grid {
    display: grid;
    grid-template-columns: repeat(32, 22px);
    row-gap: 2px;
    font-size: 15px;
  }
  .byte-addr {
    font-size: 12px;
    color: var(--text-faint);
    text-align: center;
  }
  .byte-val {
    text-align: center;
    color: var(--text);
    margin: 0 2px;
    padding-bottom: 2px;
    border-bottom: 2px solid var(--border);
    cursor: default;
  }
  .byte-val.hover,
  .byte-addr.hover {
    color: var(--blue);
    border-bottom-color: var(--blue);
  }
  .bit {
    text-align: center;
    line-height: 24px;
    color: var(--k);
    background: var(--k-dim);
    cursor: default;
  }
  .bit.fstart {
    box-shadow: inset 1px 0 0 var(--border);
  }
  .bit.hover {
    background: var(--k);
    color: var(--bg);
  }
  .field-name {
    font-size: 13px;
    text-align: center;
    color: var(--k);
    border-top: 2px solid var(--k);
    margin: 0 1px;
    padding-top: 2px;
    white-space: nowrap;
    overflow: hidden;
    cursor: default;
  }
  .field-name.hover {
    font-weight: 600;
  }

  .enc-table {
    display: grid;
    grid-template-columns: auto auto 1fr;
    font-size: 15px;
  }
  .enc-row {
    display: contents;
  }
  .enc-row > span {
    padding: 1px 12px 1px 4px;
  }
  .enc-row.hover > span {
    background: var(--surface2);
  }
  .t-name {
    color: var(--k);
  }
  .t-bits {
    color: var(--text);
  }
  .t-note {
    color: var(--text-dim);
  }

  .enc-imm {
    display: flex;
    align-items: baseline;
    gap: 4px;
    font-size: 15px;
    padding-top: 8px;
    border-top: 1px solid var(--border);
  }
  .imm-label {
    color: var(--text-dim);
  }
  .imm-part {
    color: var(--orange);
    background: var(--orange-dim);
    padding: 0 2px;
  }
  .imm-part.hover {
    background: var(--orange);
    color: var(--bg);
  }
  .imm-sep {
    color: var(--text-faint);
  }
  .imm-implicit {
    color: var(--text-faint);
    border: 1px dashed var(--border);
    padding: 0 2px;
  }
</style>
