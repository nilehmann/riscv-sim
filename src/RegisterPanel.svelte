<script lang="ts">
    import { sim, ui, fmtRegVal } from "./state.svelte";
    import { hx } from "./types";
    import HexValue from "./HexValue.svelte";
    import { _ } from "svelte-i18n";

    const isa = $derived(sim.isa);

    // Registers written by the current step. A narrower view (x86 eax) marks
    // its full register and is remembered as the name that was used.
    const written = $derived.by(() => {
        const m = new Map<string, string | null>();
        for (const name of sim.currentStep?.hiReg ?? []) {
            const sub = isa.regs.subRegBytes?.[name] !== undefined;
            m.set(isa.regs.aliases[name] ?? name, sub ? name : null);
        }
        return m;
    });

    // Status flags, with the ones whose value changed in this step.
    const flags = $derived.by(() => {
        if (!isa.flags) return [];
        const value = sim.currentStep?.regs[isa.flags.reg] ?? 0n;
        const before = sim.steps[sim.cur - 1]?.regs[isa.flags.reg] ?? value;
        const bitOf = (v: bigint, bit: number) => Number((v >> BigInt(bit)) & 1n);
        return isa.flags.bits.map(({ name, bit }) => ({
            name,
            value: bitOf(value, bit),
            changed: bitOf(value, bit) !== bitOf(before, bit),
        }));
    });
    const nextAddr = $derived(sim.currentStep?.nextAddr ?? null);

    function toggleFp() {
        ui.showFp = !ui.showFp;
        ui.firstFpArrowRender = true;
    }
</script>

<div class="reg-panel">
    <div class="panel-title">{$_('register_panel.title')}</div>
    <div class="reg-list scrollable">
        <!-- PC row -->
        <div class="reg-row pc-row">
            <span class="reg-name">{isa.regs.pc}</span>
            <span class="reg-val">{nextAddr !== null ? hx(nextAddr, isa.wordBytes) : "?"}</span
            >
            <span class="reg-desc">{$_('reg.pc')}</span>
        </div>

        <!-- Status flags -->
        {#if isa.flags}
            {#key sim.cur}
                <div class="reg-row flags-row" class:hi={written.has(isa.flags.reg)}>
                    <span class="reg-name">{$_('reg.flags')}</span>
                    <div class="flags">
                        {#each flags as f}
                            <span class="flag" class:set={f.value === 1} class:changed={f.changed}
                                data-tooltip={$_('flag.' + f.name)}
                            >{f.name}<b>{f.value}</b></span>
                        {/each}
                    </div>
                </div>
            {/key}
        {/if}

        <!-- Register rows — keyed by cur so reg-flash re-triggers each step -->
        {#key sim.cur}
            {#each sim.displayRegs as r}
                {@const val = sim.currentStep?.regs?.[r.key] ?? null}
                {@const usedAs = written.get(r.name)}
                <div class="reg-row" class:hi={written.has(r.name)}>
                    <div class="reg-row-name-line">
                        <span class="reg-name">{r.name}</span>
                        {#if usedAs}
                            <!-- Written through a narrower name, e.g. eax -->
                            <span class="sub-reg" data-tooltip={$_('register_panel.sub_reg', { values: { sub: usedAs, reg: r.name } })}>{usedAs}</span>
                        {/if}
                        {#if r.key === isa.regs.fp}
                            <button
                                class="fp-pill"
                                class:active={ui.showFp}
                                onclick={toggleFp}>fp</button
                            >
                        {/if}
                    </div>
                    {#if val !== null}
                        <HexValue value={val} elementSize={isa.wordBytes} />
                    {:else}
                        <span class="reg-val">{fmtRegVal(r.key, null)}</span>
                    {/if}
                    <span class="reg-desc">{$_('reg.' + r.key)}</span>
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
        font-size: 15px;
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
        font-size: 12px;
        font-family: var(--mono);
        padding: 1px 6px;
        border: 1px solid var(--text-faint);
        border-radius: 10px;
        cursor: pointer;
        color: var(--text-faint);
        background: transparent;
        line-height: 1.4;
    }
    .sub-reg {
        font-family: var(--mono);
        font-size: 13px;
        color: var(--orange);
        background: var(--orange-dim);
        border-radius: 4px;
        padding: 0 5px;
        line-height: 1.5;
    }
    .reg-row.flags-row {
        border-bottom: 1px solid var(--border);
        margin-bottom: 4px;
        gap: 4px;
    }
    .flags {
        display: flex;
        gap: 6px;
    }
    .flag {
        font-family: var(--mono);
        font-size: 13px;
        color: var(--text-faint);
        border: 1px solid var(--border);
        border-radius: 4px;
        padding: 1px 5px;
        display: flex;
        gap: 4px;
    }
    .flag b {
        color: var(--text-dim);
        font-weight: 600;
    }
    .flag.set {
        color: var(--text-dim);
    }
    .flag.set b {
        color: var(--text);
    }
    .flag.changed {
        border-color: var(--orange);
        background: var(--orange-dim);
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
        font-size: 18px;
        color: var(--green);
        font-weight: 600;
    }
    .reg-val {
        font-family: var(--mono);
        font-size: 17px;
        color: var(--text);
    }
    .reg-desc {
        font-size: 15px;
        color: var(--text-faint);
    }
    .reg-panel :global(.hex-val) {
        font-size: 17px;
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
