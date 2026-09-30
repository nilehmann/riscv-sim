<script lang="ts">
  import type { Concrete, SourceInstr } from "./types";
  import type { BitField, EncodingPart } from "./isa/types";
  import { hx } from "./types";
  import { sim } from "./state.svelte";
  import Tokens from "./Tokens.svelte";
  import Popover from "./Popover.svelte";
  import { _ } from "svelte-i18n";

  let {
    concrete,
    pseudo,
    labels,
    anchor,
    pinned,
    onenter,
    onleave,
    onclose,
  }: {
    concrete: Concrete;
    /** Source pseudo-instruction this instruction was expanded from, if any. */
    pseudo: SourceInstr | null;
    labels: Record<string, number>;
    anchor: { x: number; y: number };
    onenter: () => void;
    onleave: () => void;
    pinned: boolean;
    onclose: () => void;
  } = $props();

  const addr = $derived(concrete.addr);
  const enc = $derived(sim.isa.encode(concrete.instr));
  const bitParts = $derived(enc.parts.filter((p) => p.fields));
  const allFields = $derived(enc.parts.flatMap((p) => p.fields ?? []));

  // Cross-highlighting between bytes, bits, fields and immediate pieces.
  // hoverByte is the byte's offset from the instruction address.
  let hoverField = $state<string | null>(null);
  let hoverByte = $state<number | null>(null);

  const width = (p: EncodingPart) => p.length * 8;
  /** Bit numbers of a part, MSB first. */
  const bitsOf = (p: EncodingPart) => Array.from({ length: width(p) }, (_, i) => width(p) - 1 - i);
  /** Byte offsets of a part, highest address first so bits read MSB→LSB. */
  const bytesOf = (p: EncodingPart) =>
    Array.from({ length: p.length }, (_, i) => p.offset + p.length - 1 - i);

  function bitValue(p: EncodingPart, bit: number): number {
    return (enc.bytes[p.offset + (bit >> 3)]! >> (bit & 7)) & 1;
  }
  function fieldOf(p: EncodingPart, bit: number): BitField {
    return p.fields!.find((f) => bit >= f.lo && bit <= f.hi)!;
  }
  function bitCol(p: EncodingPart, bit: number): number {
    return width(p) - bit;
  }
  function span(f: BitField): number {
    return f.hi - f.lo + 1;
  }
  function bin(v: number, w: number): string {
    return v.toString(2).padStart(w, "0");
  }
  function hexByte(b: number): string {
    return b.toString(16).toUpperCase().padStart(2, "0");
  }
  // Label fits under the field when it is no wider than the field's columns.
  // Keep in sync with .enc-grid column width and .field-name font size.
  const BIT_COL_PX = 22;
  const LABEL_CHAR_PX = 13 * 0.6;
  function fitsLabel(f: BitField): boolean {
    return f.name.length * LABEL_CHAR_PX <= span(f) * BIT_COL_PX - 4;
  }
</script>

<Popover {anchor} {pinned} {onenter} {onleave}>
  <div class="enc-header">
    <span class="enc-instr"><Tokens tokens={sim.isa.tokens(concrete.instr, addr)} /></span>
    {#if enc.format}
      <span class="enc-format">{$_("encoding.format", { values: { format: enc.format } })}</span>
    {/if}
    {#if pinned}
      <button class="enc-close" onclick={onclose} aria-label={$_("encoding.close")}>✕</button>
    {:else}
      <span class="enc-hint">{$_("encoding.pin_hint")}</span>
    {/if}
  </div>
  {#if pseudo}
    <div class="enc-pseudo">
      {$_("encoding.expanded_from")} <Tokens tokens={sim.isa.sourceTokens(pseudo.parsed, pseudo.raw, labels)} />
    </div>
  {/if}

  {#each bitParts as part}
    <div class="enc-grid" style="grid-template-columns: repeat({width(part)}, {BIT_COL_PX}px)">
      <!-- Bytes in memory: highest address on the left so bits read MSB→LSB -->
      {#each bytesOf(part) as k, i}
        <span
          class="byte-addr"
          class:hover={hoverByte === k}
          style="grid-row:1; grid-column:{i * 8 + 1} / span 8"
        >{hx(addr + k)}</span>
        <span
          class="byte-val"
          class:hover={hoverByte === k}
          style="grid-row:2; grid-column:{i * 8 + 1} / span 8"
          role="presentation"
          onmouseenter={() => (hoverByte = k)}
          onmouseleave={() => (hoverByte = null)}
        >{hexByte(enc.bytes[k]!)}</span>
      {/each}

      <!-- The bits, colored by field -->
      {#each bitsOf(part) as bit}
        {@const f = fieldOf(part, bit)}
        <span
          class="bit k-{f.kind}"
          class:fstart={bit === f.hi}
          class:hover={hoverField === f.name || hoverByte === part.offset + (bit >> 3)}
          style="grid-row:3; grid-column:{bitCol(part, bit)}"
          data-tooltip="bit {bit}"
          role="presentation"
          onmouseenter={() => (hoverField = f.name)}
          onmouseleave={() => (hoverField = null)}
        >{bitValue(part, bit)}</span>
      {/each}

      <!-- Field brackets and names -->
      {#each part.fields! as f}
        <span
          class="field-name k-{f.kind}"
          class:hover={hoverField === f.name}
          style="grid-row:4; grid-column:{bitCol(part, f.hi)} / span {span(f)}"
          role="presentation"
          onmouseenter={() => (hoverField = f.name)}
          onmouseleave={() => (hoverField = null)}
        >{fitsLabel(f) ? f.name : ""}</span>
      {/each}
    </div>
  {/each}

  <!-- One row per field, same order as the bits -->
  <div class="enc-table">
    {#each allFields as f}
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
</Popover>

<style>
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
