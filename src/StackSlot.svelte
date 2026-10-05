<script lang="ts">
    import type { SlotLabel } from "./types";
    import { sim, ui } from "./state.svelte";
    import { subSlots, readWritten, overlapsAccess } from "./memUtils";
    import { fmtAddr } from "./types";
    import HexValue from "./HexValue.svelte";
    import SlotMode from "./SlotMode.svelte";

    let {
        addr,
        size,
        mode,
        memVal,
        gWord,
        labels = null,
        faint = false,
        disabled = false,
        onModeChange,
    }: {
        addr: number;
        /** Slot size in bytes. */
        size: 4 | 8;
        /** Size in bytes of the pieces the slot is shown as (`size` = whole). */
        mode: number;
        memVal: bigint | undefined;
        gWord: bigint;
        /** What memory holds, by address; pieces of a slot can have their own. */
        labels?: Map<number, SlotLabel> | null;
        faint?: boolean;
        disabled?: boolean;
        onModeChange: (m: number) => void;
    } = $props();

    const step = $derived(sim.currentStep);
    const name = (a: number) => {
        const label = labels?.get(a)?.name;
        return label ? `${fmtAddr(a)}  ${label}` : fmtAddr(a);
    };
</script>

<div class="slot-header">
    <SlotMode {mode} {size} {disabled} transparent onchange={onModeChange} />
    {#if mode === size}
        <span class="slot-name">{name(addr)}</span>
    {:else}
        <div class="sub-slots-col">
            {#each subSlots(addr, size, mode as 1 | 2 | 4).toReversed() as sub}
                {@const subVal = step ? readWritten(step.mem, sub.addr, sub.size) : undefined}
                {@const byteOff = sub.addr - addr}
                {@const subGarbage = BigInt.asUintN(sub.size * 8, gWord >> BigInt(byteOff * 8))}
                <div
                    class="sub-slot"
                    class:hi={overlapsAccess(sub.addr, sub.size, step?.access)}
                    data-addr={sub.addr}
                >
                    <span class="slot-name">{name(sub.addr)}</span>
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
{#if mode === size}
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
        position: relative;
        display: flex;
        flex-direction: row;
        justify-content: space-between;
        align-items: center;
        width: 100%;
    }
    .sub-slot::after {
        content: "";
        position: absolute;
        /* Out to the slot's right padding. */
        inset: -2px -16px -2px -4px;
        background: var(--orange-dim);
        opacity: 0;
        pointer-events: none;
    }
    @keyframes sub-slot-flash {
        0% { opacity: 1; }
        100% { opacity: 0; }
    }
    .sub-slot.hi::after {
        animation: sub-slot-flash 0.8s ease-out forwards;
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
