<script lang="ts">
  import { sim } from "./state.svelte";
  import TypedRegion from "./TypedRegion.svelte";
</script>

{#if sim.regions.length}
  <div class="memory-panel">
    {#each sim.regions as region (region.name)}
      <TypedRegion {region} />
    {/each}
  </div>
{/if}

<style>
  .memory-panel {
    display: flex;
    flex-direction: column;
    gap: 20px;
    padding: 16px 24px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    min-width: 0;
  }
</style>
