<script lang="ts">
    import { sim, ui } from "./state.svelte";
    import { subSlots, readWritten } from "./memUtils";
    import { hx } from "./types";
    import HexValue from "./HexValue.svelte";
    import SlotMode from "./SlotMode.svelte";

    let {
        addr,
        size,
        mode,
        memVal,
        gWord,
        label = null,
        faint = false,
        disabled = false,
        onModeChange,
    }: {
        addr: number;
        /** Slot size in bytes. */
        size: 4 | 8;
        mode: 'word' | 'halfword' | 'byte';
        memVal: bigint | undefined;
        gWord: bigint;
        label?: string | null;
        faint?: boolean;
        disabled?: boolean;
        onModeChange: (m: 'word' | 'halfword' | 'byte') => void;
    } = $props();

    const step = $derived(sim.currentStep);
</script>

<div class="slot-header">
    <SlotMode {mode} {disabled} transparent onchange={onModeChange} />
    {#if mode === 'word'}
        <span class="slot-name">{label ? `${hx(addr)}  ${label}` : hx(addr)}</span>
    {:else}
        <div class="sub-slots-col">
            {#each subSlots(addr, size, mode).toReversed() as sub, si}
                {@const subVal = step ? readWritten(step.mem, sub.addr, sub.size) : undefined}
                {@const subLabel = si === 0 ? label : null}
                {@const byteOff = sub.addr - addr}
                {@const subGarbage = BigInt.asUintN(sub.size * 8, gWord >> BigInt(byteOff * 8))}
                <div class="sub-slot" data-addr={sub.addr}>
                    <span class="slot-name">{subLabel ? `${hx(sub.addr)}  ${subLabel}` : hx(sub.addr)}</span>
                    {#if subVal !== undefined}
                        <HexValue value={subVal} elementSize={sub.size} faint={faint} />
                    {:else if ui.showGarbage}
                        <HexValue value={subGarbage} elementSize={sub.size} faint={true} />
                    {:else}
                        <span class="slot-uninit">—</span>
                    {/if}
                </div>
            {/each}
        </div>
    {/if}
</div>
{#if mode === 'word'}
    {#if memVal !== undefined}
        <HexValue value={memVal} elementSize={size} {faint} />
    {:else if ui.showGarbage}
        <HexValue value={gWord} elementSize={size} faint={true} />
    {:else}
        <span class="slot-uninit">—</span>
    {/if}
{/if}

<style>
    .slot-header {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        flex: 1;
    }
    .sub-slots-col {
        display: flex;
        flex-direction: column;
        gap: 4px;
        flex: 1;
    }
    .sub-slot {
        display: flex;
        flex-direction: row;
        justify-content: space-between;
        align-items: center;
        width: 100%;
    }
    .slot-name {
        color: var(--text-dim);
    }
    .slot-uninit {
        color: var(--text);
        font-weight: 600;
        font-family: var(--mono);
        font-size: 16px;
    }
</style>
