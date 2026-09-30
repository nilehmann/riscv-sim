<script lang="ts">
  import type { Token } from "./isa/types";
  import { hx } from "./types";

  // Renders syntax-highlighted instruction tokens (see Isa.tokens/sourceTokens).
  let { tokens }: { tokens: Token[] } = $props();
</script>

{#each tokens as tok}
  {#if tok.kind === "kw"}
    <span class="kw">{tok.text}</span>
  {:else if tok.kind === "reg"}
    <span class="reg">{tok.text}</span>
  {:else if tok.kind === "imm"}
    <span class="imm">{tok.text}</span>
  {:else if tok.kind === "label"}
    {#if tok.addr !== undefined}
      <span class="fn" data-target-addr={tok.addr} data-tooltip="addr: {hx(tok.addr)}">{tok.text}</span>
    {:else}
      <span class="fn">{tok.text}</span>
    {/if}
  {:else}
    {tok.text}
  {/if}
{/each}
