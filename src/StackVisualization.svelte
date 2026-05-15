<script lang="ts">
    import type { FrameInfo, Step } from "./types";
    import { sim, ui } from "./state.svelte";
    import { hx } from "./assembler";
    import HexValue from "./HexValue.svelte";

    // ─── Constants ────────────────────────────────────────────────────────
    const FRAME_COLORS = [
        "var(--green-dim)",
        "var(--blue-dim)",
        "var(--orange-dim)",
        "var(--purple-dim)",
    ];
    const GHOST_ROWS = 3;
    const OFFSET_MAX = 64;

    // ─── Reactive stack data ──────────────────────────────────────────────

    const step = $derived(sim.currentStep);

    const currentSp = $derived(step?.regs?.sp ?? 0);

    const callerBase = $derived(
        sim.currentCallFrames.length > 0
            ? sim.currentCallFrames[0]!.entrySpBefore
            : currentSp + 16,
    );

    const activeFrames = $derived(
        sim.currentCallFrames.filter((f) => currentSp < f.entrySpBefore),
    );

    const hiS = $derived(new Set(step?.hiSlots ?? []));

    // Ghost rows above (caller)
    const callerGhostRows = $derived(
        Array.from({ length: GHOST_ROWS }, (_, i) => ({
            addr: callerBase + (GHOST_ROWS - i) * 4,
            opacity: ((i + 1) / (GHOST_ROWS + 1)).toFixed(2),
        })),
    );

    // Ghost rows below (free zone)
    const freeGhostRows = $derived(
        Array.from({ length: GHOST_ROWS }, (_, i) => ({
            addr: currentSp - (i + 1) * 4,
            opacity: ((GHOST_ROWS - i) / (GHOST_ROWS + 1)).toFixed(2),
        })),
    );

    // ─── DOM refs for post-layout arrow positioning ───────────────────────
    let wrapperEl = $state<HTMLElement | null>(null);
    let columnEl = $state<HTMLElement | null>(null);
    let spArrowEl = $state<HTMLElement | null>(null);
    let fpArrowEl = $state<HTMLElement | null>(null);
    let labelsEl = $state<HTMLElement | null>(null);
    let offsetsEl = $state<HTMLElement | null>(null);

    // slot-addr → element: populated by bind:this on each slot div
    let slotEls = $state<Map<number, HTMLElement>>(new Map());

    // Svelte action that registers slot elements into slotEls map
    function registerSlotAction(el: HTMLElement, addr: number) {
        slotEls = new Map(slotEls).set(addr, el);
        return {
            update(newAddr: number) {
                slotEls = new Map(slotEls);
                slotEls.delete(addr);
                slotEls.set(newAddr, el);
                addr = newAddr;
            },
            destroy() {
                slotEls = new Map(slotEls);
                slotEls.delete(addr);
            },
        };
    }

    // ─── Arrow positioning $effect ────────────────────────────────────────
    $effect(() => {
        // Touch all reactive dependencies needed for positioning
        const _step = step;
        const _sp = currentSp;
        const _callerBase = callerBase;
        const _activeFrames = activeFrames;
        const _showFp = ui.showFp;
        const _slots = slotEls; // reactive map

        if (!wrapperEl || !_step) return;

        requestAnimationFrame(() => {
            positionSpArrow(_step, _sp, _callerBase);
            positionLabels(_activeFrames);
            positionOffsets(_step, _sp);
            if (ui.showFp) positionFpArrow(_step, _callerBase);
        });
    });

    function positionArrow(
        arrow: HTMLElement | null,
        targetAddr: number,
        fallbackAddr: number,
        firstRenderFlag: boolean,
        setFirstRenderDone: () => void,
    ) {
        if (!arrow || !wrapperEl) return;
        let target =
            slotEls.get(targetAddr) ?? slotEls.get(fallbackAddr) ?? null;
        if (!target) return;
        const wRect = wrapperEl.getBoundingClientRect();
        const tRect = target.getBoundingClientRect();
        const top = tRect.top - wRect.top + tRect.height / 2;
        if (firstRenderFlag) {
            arrow.style.transition = "none";
            arrow.style.top = top + "px";
            arrow.getBoundingClientRect(); // force reflow
            arrow.style.transition = "";
            setFirstRenderDone();
        } else {
            arrow.style.top = top + "px";
        }
    }

    function positionSpArrow(_step: Step, _sp: number, _callerBase: number) {
        let firstRender = ui.firstArrowRender;
        positionArrow(spArrowEl, _sp, _callerBase, firstRender, () => {
            ui.firstArrowRender = false;
        });
    }

    function positionFpArrow(_step: Step, _callerBase: number) {
        const fpAddr = _step.regs?.s0 ?? 0;
        let firstRender = ui.firstFpArrowRender;
        positionArrow(fpArrowEl, fpAddr, _callerBase, firstRender, () => {
            ui.firstFpArrowRender = false;
        });
    }

    function positionLabels(_activeFrames: FrameInfo[]) {
        if (!labelsEl || !columnEl) return;
        const colTop = columnEl.getBoundingClientRect().top;
        let html = "";
        for (let fi = 0; fi < _activeFrames.length; fi++) {
            const frame = _activeFrames[fi]!;
            // First slot of this frame is at frameTop - 4
            const firstSlotAddr = frame.entrySpBefore - 4;
            const slotEl = slotEls.get(firstSlotAddr);
            if (!slotEl) continue;
            const rect = slotEl.getBoundingClientRect();
            const top = rect.top - colTop + rect.height / 2;
            html += `<span class="flabel" style="top:${top}px">${frame.label}</span>`;
        }
        labelsEl.innerHTML = html;
    }

    function positionOffsets(_step: Step, _sp: number) {
        if (!offsetsEl || !wrapperEl) return;
        const wTop = wrapperEl.getBoundingClientRect().top;
        let html = "";
        for (const [addr, el] of slotEls) {
            const offset = addr - _sp;
            if (offset === 0) continue;
            if (Math.abs(offset) > OFFSET_MAX) continue;
            const sign = offset > 0 ? "+" : "";
            const opacity = parseFloat(el.style.opacity || "1");
            const rect = el.getBoundingClientRect();
            const top = rect.top - wTop + rect.height / 2;
            html += `<div class="offset-arrow" style="top:${top}px;opacity:${opacity}">sp${sign}${offset}</div>`;
        }
        offsetsEl.innerHTML = html;
    }

    function getSlotMemVal(addr: number): number | undefined {
        if (!step?.mem) return undefined;
        const b0 = step.mem.get(addr);
        const b1 = step.mem.get(addr + 1);
        const b2 = step.mem.get(addr + 2);
        const b3 = step.mem.get(addr + 3);
        if (b0 === undefined && b1 === undefined && b2 === undefined && b3 === undefined)
            return undefined;
        return (
            ((b0 ?? 0) & 0xff) |
            (((b1 ?? 0) & 0xff) << 8) |
            (((b2 ?? 0) & 0xff) << 16) |
            (((b3 ?? 0) & 0xff) << 24)
        );
    }

    function subSlots(addr: number, mode: 'halfword' | 'byte') {
        const subSize: 1 | 2 = mode === 'byte' ? 1 : 2;
        const count = 4 / subSize;
        return Array.from({ length: count }, (_, i) => ({
            addr: addr + i * subSize,
            size: subSize as 1 | 2,
            offset: i * subSize,
        }));
    }

    function slotMode(key: string): 'word' | 'halfword' | 'byte' {
        return ui.slotViewMode.get(key) ?? 'word';
    }

    function setSlotMode(key: string, mode: 'word' | 'halfword' | 'byte') {
        const next = new Map(ui.slotViewMode);
        next.set(key, mode);
        ui.slotViewMode = next;
    }

</script>

<div class="stack-area scrollable">
    {#if sim.loadError}
        {@const e = sim.loadError}
        <div class="config-error">
            <div class="config-error-title">Error</div>
            {#if e.message}
                <p>{e.message}</p>
            {/if}
            {#if e.detail}
                <p class="config-error-hint">{e.detail}</p>
            {/if}
        </div>
    {:else if step}
        <div class="stack-wrapper" bind:this={wrapperEl}>
            <!-- Offset labels (left of stack) -->
            <div class="offset-arrows" bind:this={offsetsEl}></div>

            <!-- FP arrow -->
            <!-- svelte-ignore binding_property_non_reactive -->
            <div
                class="fp-arrow"
                bind:this={fpArrowEl}
                style="display: {ui.showFp ? 'flex' : 'none'}"
            >
                <span class="fp-label">fp</span>
                <span class="fp-arrow-shaft"></span>
                <span class="fp-arrow-head"></span>
            </div>

            <!-- SP arrow -->
            <div class="sp-arrow" bind:this={spArrowEl}>
                <span class="sp-label">sp</span>
                <span class="sp-arrow-shaft"></span>
                <span class="sp-arrow-head"></span>
            </div>

            <!-- Stack column -->
            <div class="stack-column" bind:this={columnEl}>
                <!-- Caller ghost (above) -->
                <div class="frame caller" id="fr-caller">
                    <div class="frame-ellipsis">
                        <div>dirección alta</div>
                        <div>↑</div>
                    </div>
                    {#each callerGhostRows as row}
                        <div
                            class="frame-slot"
                            id="slot-{row.addr.toString(16)}"
                            style="opacity:{row.opacity}"
                            use:registerSlotAction={row.addr}
                        >
                            <div class="slot-header">
                                <select class="slot-select" disabled style="visibility:hidden"><option>w</option></select>
                                <span class="slot-name">{hx(row.addr)}</span>
                            </div>
                            <span class="slot-uninit">—</span>
                        </div>
                    {/each}
                    <!-- Boundary slot at callerBase -->
                    <div
                        class="frame-slot"
                        id="slot-{callerBase.toString(16)}"
                        use:registerSlotAction={callerBase}
                    >
                        <div class="slot-header">
                            <select class="slot-select" disabled style="visibility:hidden"><option>w</option></select>
                            <span class="slot-name">{hx(callerBase)}</span>
                        </div>
                        <span class="slot-uninit" style="color:var(--text-faint)">—</span>
                    </div>
                </div>

                <!-- Active frames -->
                {#each activeFrames as frame, fi}
                    {@const color = FRAME_COLORS[fi % FRAME_COLORS.length]}
                    {@const frameTop = frame.entrySpBefore}
                    {@const frameBot =
                        frame.entrySpBefore - frame.allocatedSize}
                    {@const frameSlots = Array.from(
                        { length: (frameTop - frameBot) / 4 },
                        (_, i) => frameTop - 4 - i * 4,
                    )}
                    <div
                        class="frame"
                        id="fr-active-{fi}"
                        data-label={frame.label}
                    >
                        {#each frameSlots as addr}
                            {@const label = sim.currentSlotLabels.get(addr)}
                            {@const memVal = getSlotMemVal(addr)}
                            {@const isHi = hiS.has(addr)}
                            {@const key = `stack-${addr.toString(16)}`}
                            {@const mode = slotMode(key)}
                            <div
                                class="frame-slot"
                                class:hi={isHi}
                                id="slot-{addr.toString(16)}"
                                style="background:{color}"
                                use:registerSlotAction={addr}
                            >
                                <div class="slot-header">
                                    <select
                                        class="slot-select"
                                        value={mode}
                                        onchange={(e) => setSlotMode(key, e.currentTarget.value as 'word' | 'halfword' | 'byte')}
                                    >
                                        <option value="word">w</option>
                                        <option value="halfword">h</option>
                                        <option value="byte">b</option>
                                    </select>
                                    {#if mode === 'word'}
                                        <span
                                            class="slot-name"
                                            style={label ? "color:var(--blue)" : ""}
                                            >{label
                                                ? `${hx(addr)}  ${label}`
                                                : hx(addr)}</span
                                        >
                                    {:else}
                                        <div class="sub-slots-col">
                                            {#each subSlots(addr, mode) as sub, si}
                                                {@const subVal = step?.mem.get(sub.addr)}
                                                {@const subLabel = si === 0 ? label : null}
                                                <div class="sub-slot">
                                                    <span
                                                        class="slot-name"
                                                        style={subLabel ? "color:var(--blue)" : ""}
                                                    >{subLabel ? `${hx(sub.addr)}  ${subLabel}` : hx(sub.addr)}</span>
                                                    {#if subVal !== undefined}
                                                        <HexValue value={subVal} elementSize={sub.size} />
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
                                        <HexValue value={memVal} />
                                    {:else}
                                        <span class="slot-uninit">—</span>
                                    {/if}
                                {/if}
                            </div>
                        {/each}
                    </div>
                {/each}

                <!-- Free zone (below sp) -->
                <div class="frame free" id="fr-free">
                    {#each freeGhostRows as row}
                        <div
                            class="frame-slot"
                            style="opacity:{row.opacity};background:var(--bg);border-top-style:dashed"
                            use:registerSlotAction={row.addr}
                        >
                            <div class="slot-header">
                                <select class="slot-select" disabled style="visibility:hidden"><option>w</option></select>
                                <span class="slot-name" style="color:var(--text-faint)">{hx(row.addr)}</span>
                            </div>
                            <span class="slot-uninit" style="color:var(--text-faint)">—</span>
                        </div>
                    {/each}
                    <div class="frame-ellipsis">
                        <div>↓</div>
                        <div>dirección baja</div>
                    </div>
                </div>
            </div>

            <!-- Frame labels (right of stack) -->
            <div class="frame-labels" bind:this={labelsEl}></div>
        </div>
    {/if}
</div>

<style>
    .slot-header {
        display: flex;
        align-items: flex-start;
        gap: 8px;
    }
    .slot-select {
        font-size: 10px;
        padding: 1px 2px;
        border: 1px solid var(--border);
        border-radius: 3px;
        background: transparent;
        color: var(--text-faint);
        cursor: pointer;
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
    .sub-addr {
        font-family: var(--mono);
        font-size: 11px;
        color: var(--text-faint);
    }
    .stack-area {
        flex: 1;
        overflow-y: auto;
        padding: 20px 24px;
        display: flex;
        flex-direction: column;
        justify-content: flex-start;
        align-items: center;
    }
    .config-error {
        padding: 32px 24px;
        color: var(--red);
        font-family: var(--mono);
        font-size: 15px;
        line-height: 1.8;
        max-width: 420px;
    }
    .config-error-title {
        font-weight: 600;
        font-size: 17px;
        margin-bottom: 12px;
    }
    .config-error-hint {
        color: var(--text-dim);
    }
    .stack-wrapper {
        display: flex;
        align-items: flex-start;
        position: relative;
        gap: 12px;
    }
    .offset-arrows {
        position: absolute;
        right: 100%;
        top: 0;
        height: 100%;
        pointer-events: none;
    }
    :global(.offset-arrow) {
        position: absolute;
        right: 0;
        font-family: var(--mono);
        font-size: 16px;
        color: var(--text-faint);
        white-space: nowrap;
        transform: translateY(-50%);
        display: flex;
        align-items: center;
        padding-right: 8px;
    }
    .sp-arrow {
        position: absolute;
        right: 100%;
        font-family: var(--mono);
        font-size: 16px;
        color: var(--green);
        white-space: nowrap;
        pointer-events: none;
        transform: translateY(-50%);
        transition: top 0.45s ease;
        display: flex;
        align-items: center;
        padding-right: 8px;
    }
    .sp-label {
        margin-right: 6px;
    }
    .sp-arrow-shaft {
        display: inline-block;
        width: 20px;
        height: 2px;
        background: currentColor;
    }
    .sp-arrow-head {
        display: inline-block;
        width: 0;
        height: 0;
        border-top: 6px solid transparent;
        border-bottom: 6px solid transparent;
        border-left: 9px solid currentColor;
    }
    .fp-arrow {
        position: absolute;
        right: calc(100% + 65px);
        font-family: var(--mono);
        font-size: 16px;
        color: var(--blue);
        white-space: nowrap;
        pointer-events: none;
        transform: translateY(-50%);
        transition: top 0.45s ease;
        display: flex;
        align-items: center;
        padding-right: 8px;
    }
    .fp-label {
        margin-right: 6px;
    }
    .fp-arrow-shaft {
        display: inline-block;
        width: 20px;
        height: 2px;
        background: currentColor;
    }
    .fp-arrow-head {
        display: inline-block;
        width: 0;
        height: 0;
        border-top: 6px solid transparent;
        border-bottom: 6px solid transparent;
        border-left: 9px solid currentColor;
    }
    .stack-column {
        border-left: 1px solid var(--border);
        border-right: 1px solid var(--border);
        margin-top: 20px;
        overflow: hidden;
        flex: 0 0 auto;
        min-width: 320px;
    }
    .frame-labels {
        position: absolute;
        left: calc(100% + 12px);
        top: 0;
    }
    :global(.flabel) {
        position: absolute;
        left: 0;
        font-family: var(--mono);
        font-size: 16px;
        color: var(--text-dim);
        transform: translateY(-50%);
        white-space: nowrap;
        pointer-events: none;
    }
    .frame {
        overflow: hidden;
    }
    .frame-slot {
        border-top: 1px solid var(--border);
        padding: 8px 16px;
        font-family: var(--mono);
        font-size: 16px;
        display: flex;
        flex-direction: row;
        justify-content: space-between;
        align-items: center;
        background: var(--surface);
        position: relative;
    }
    .frame-slot .slot-header:only-child {
        flex: 1;
    }
    .frame-slot::after {
        content: "";
        position: absolute;
        inset: 0;
        background: var(--orange-dim);
        opacity: 0;
        pointer-events: none;
    }
    @keyframes slot-flash {
        0% {
            opacity: 1;
        }
        100% {
            opacity: 0;
        }
    }
    .frame-slot.hi::after {
        animation: slot-flash 0.8s ease-out forwards;
    }
    .frame.caller .frame-slot {
        background: rgba(100, 110, 120, 0.08);
    }
    .frame-ellipsis {
        border-top: 1px solid var(--border);
        padding: 5px 16px;
        font-family: var(--mono);
        font-size: 16px;
        color: var(--text-faint);
        text-align: center;
        letter-spacing: 0.15em;
    }
    .frame.caller .frame-ellipsis {
        border-top: none;
        border-bottom: 1px solid var(--border);
    }
    .frame.free .frame-ellipsis {
        border-bottom: none;
    }
    .frame.free .frame-slot {
        background: var(--bg);
        border-top-style: dashed;
    }
    .frame.free .slot-name,
    .frame.free .slot-uninit {
        color: var(--text-faint);
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
