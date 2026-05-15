<script lang="ts">
    import { sim, ui, fmtRegVal } from "./state.svelte";
    import { hx } from "./assembler";
    import HexValue from "./HexValue.svelte";

    const hiR = $derived(new Set(sim.currentStep?.hiReg ?? []));
    const nextAddr = $derived(sim.currentStep?.nextAddr ?? null);

    function toggleFp() {
        ui.showFp = !ui.showFp;
        ui.firstFpArrowRender = true;
    }
</script>

<div class="reg-panel">
    <div class="panel-title">Registros</div>
    <div class="reg-list scrollable">
        <!-- PC row -->
        <div class="reg-row pc-row">
            <span class="reg-name">pc</span>
            <span class="reg-val">{nextAddr !== null ? hx(nextAddr) : "?"}</span
            >
            <span class="reg-desc">program counter</span>
        </div>

        <!-- Register rows — keyed by cur so reg-flash re-triggers each step -->
        {#key sim.cur}
            {#each sim.displayRegs as r}
                {@const val = sim.currentStep?.regs?.[r.key] ?? null}
                <div class="reg-row" class:hi={hiR.has(r.name)}>
                    {#if r.key === "s0"}
                        <div class="reg-row-name-line">
                            <span class="reg-name">{r.name}</span>
                            <button
                                class="fp-pill"
                                class:active={ui.showFp}
                                onclick={toggleFp}>fp</button
                            >
                        </div>
                    {:else}
                        <span class="reg-name">{r.name}</span>
                    {/if}
                    {#if val !== null}
                        <HexValue value={val} />
                    {:else}
                        <span class="reg-val">{fmtRegVal(r.key, null)}</span>
                    {/if}
                    <span class="reg-desc">{r.desc}</span>
                </div>
            {/each}
        {/key}
    </div>
</div>

<style>
    .reg-panel {
        border-left: 1px solid var(--border);
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }
    .panel-title {
        font-family: var(--mono);
        font-size: 14px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--text-dim);
        padding: 9px 12px;
        border-bottom: 1px solid var(--border);
        background: var(--surface);
        flex-shrink: 0;
    }
    .reg-list {
        flex: 1;
        overflow-y: auto;
        padding: 8px 0;
    }
    .reg-row-name-line {
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .fp-pill {
        font-size: 11px;
        font-family: var(--mono);
        padding: 1px 6px;
        border: 1px solid var(--text-faint);
        border-radius: 10px;
        cursor: pointer;
        color: var(--text-faint);
        background: transparent;
        line-height: 1.4;
    }
    .fp-pill.active {
        color: var(--blue);
        border-color: var(--blue);
        background: var(--blue-dim);
    }
    .reg-row {
        display: flex;
        flex-direction: column;
        padding: 8px 16px;
        gap: 1px;
        border-left: 2px solid transparent;
    }
    @keyframes reg-flash {
        0% {
            background: var(--orange-dim);
            border-left-color: var(--orange);
        }
        100% {
            background: transparent;
            border-left-color: transparent;
        }
    }
    .reg-row.hi {
        animation: reg-flash 0.8s ease-out forwards;
    }
    .reg-row.pc-row {
        border-bottom: 1px solid var(--border);
        margin-bottom: 4px;
    }
    .reg-row.pc-row .reg-name {
        color: var(--blue);
    }
    .reg-name {
        font-family: var(--mono);
        font-size: 17px;
        color: var(--green);
        font-weight: 600;
    }
    .reg-val {
        font-family: var(--mono);
        font-size: 16px;
        color: var(--text);
    }
    .reg-desc {
        font-size: 14px;
        color: var(--text-faint);
    }
    .scrollable::-webkit-scrollbar {
        width: 4px;
    }
    .scrollable::-webkit-scrollbar-track {
        background: transparent;
    }
    .scrollable::-webkit-scrollbar-thumb {
        background: var(--border);
        border-radius: 2px;
    }
</style>
