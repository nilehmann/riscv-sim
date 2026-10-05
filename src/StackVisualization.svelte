<script lang="ts">
    import type { FrameInfo, Step } from "./types";
    import { sim, ui } from "./state.svelte";
    import { readWritten } from "./memUtils";
    import { garbageMem } from "./garbage";
    import StackSlot from "./StackSlot.svelte";
    import { _ } from "svelte-i18n";

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
    /** Slot size in bytes. */
    const S = $derived(sim.isa.slotBytes);
    const spName = $derived(sim.isa.regs.sp);

    const currentSp = $derived(Number(step?.regs?.[sim.isa.regs.sp] ?? 0));

    const callerBase = $derived(
        sim.currentCallFrames.length > 0
            ? sim.currentCallFrames[0]!.entrySpBefore
            : currentSp + 16,
    );

    const activeFrames = $derived(
        sim.currentCallFrames.filter((f) => currentSp < f.entrySpBefore),
    );

    const hiS = $derived(new Set(step?.hiSlots ?? []));

    // Ghost rows above (caller) — includes callerBase itself as the last opaque row
    const callerGhostRows = $derived(
        Array.from({ length: GHOST_ROWS + 1 }, (_, i) => ({
            addr: callerBase + (GHOST_ROWS - i) * S,
            opacity: i < GHOST_ROWS ? ((i + 1) / (GHOST_ROWS + 1)).toFixed(2) : "1",
        })),
    );

    // Red zone: slots below sp the top frame has stored to without moving sp.
    const redZoneRows = $derived.by(() => {
        const low = sim.currentCallFrames.at(-1)?.lowWrite;
        if (low == null || low >= currentSp) return [];
        const count = Math.ceil((currentSp - low) / S);
        return Array.from({ length: count }, (_, i) => currentSp - (i + 1) * S);
    });

    // Ghost rows below (free zone). Once the entry function has returned, sp is
    // above the caller rows, which already cover the slots down to callerBase.
    const freeGhostRows = $derived(
        Array.from({ length: GHOST_ROWS }, (_, i) => ({
            addr: Math.min(currentSp, callerBase) - (redZoneRows.length + i + 1) * S,
            opacity: ((GHOST_ROWS - i) / (GHOST_ROWS + 1)).toFixed(2),
        })),
    );

    // ─── DOM refs for post-layout arrow positioning ───────────────────────
    let wrapperEl = $state<HTMLElement | null>(null);
    let columnEl = $state<HTMLElement | null>(null);
    let spArrowEl = $state<HTMLElement | null>(null);
    let fpArrowEl = $state<HTMLElement | null>(null);
    let labelsEl = $state<HTMLElement | null>(null);
    let redZoneEl = $state<HTMLElement | null>(null);
    let offsetsEl = $state<HTMLElement | null>(null);

    // slot-addr → element, kept up to date by registerSlotAction. A plain map
    // mutated in place: copying reactive state on every change loses updates,
    // because a teardown (destroy) reads the state as it was before the batch.
    const slotEls = new Map<number, HTMLElement>();
    // Bumped whenever slotEls changes, to re-run the positioning effect.
    let slotsVersion = $state(0);
    let slotChanges = 0;
    const slotsChanged = () => (slotsVersion = ++slotChanges);

    // Svelte action that registers slot elements into slotEls map
    function registerSlotAction(el: HTMLElement, addr: number) {
        slotEls.set(addr, el);
        slotsChanged();
        return {
            // Another row may already have taken over this one's old address,
            // so only remove the entry if it is still ours.
            update(newAddr: number) {
                if (slotEls.get(addr) === el) slotEls.delete(addr);
                slotEls.set(newAddr, el);
                addr = newAddr;
                slotsChanged();
            },
            destroy() {
                if (slotEls.get(addr) === el) slotEls.delete(addr);
                slotsChanged();
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
        const _slotViewMode = ui.slotViewMode;
        const _slotLabels = sim.currentSlotLabels;
        const _redZone = redZoneRows;
        const _slots = slotsVersion; // slot elements changed

        if (!wrapperEl || !_step) return;

        requestAnimationFrame(() => {
            positionSpArrow(_step, _sp, _callerBase);
            positionLabels(_activeFrames);
            positionOffsets(_step, _sp);
            if (ui.showFp) positionFpArrow(_step, _callerBase);
        });
    });

    function resolveSlotTarget(addr: number): Element | null {
        const el = slotEls.get(addr);
        if (!el) return null;
        if (slotMode(addr) !== S) {
            return el.querySelector(`.sub-slot[data-addr="${addr}"]`) ?? el;
        }
        return el;
    }

    function positionArrow(
        arrow: HTMLElement | null,
        target: Element | null,
        firstRenderFlag: boolean,
        setFirstRenderDone: () => void,
    ) {
        if (!arrow || !wrapperEl || !target) return;
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
        const target = resolveSlotTarget(_sp) ?? resolveSlotTarget(_callerBase);
        positionArrow(spArrowEl, target, ui.firstArrowRender, () => {
            ui.firstArrowRender = false;
        });
    }

    function positionFpArrow(_step: Step, _callerBase: number) {
        const fpAddr = Number(_step.regs?.[sim.isa.regs.fp] ?? 0);
        const target = resolveSlotTarget(fpAddr) ?? resolveSlotTarget(_callerBase);
        positionArrow(fpArrowEl, target, ui.firstFpArrowRender, () => {
            ui.firstFpArrowRender = false;
        });
    }

    function positionLabels(_activeFrames: FrameInfo[]) {
        if (!labelsEl || !columnEl) return;
        const colTop = columnEl.getBoundingClientRect().top;
        let html = "";
        for (let fi = 0; fi < _activeFrames.length; fi++) {
            const frame = _activeFrames[fi]!;
            // First slot of this frame is at frameTop - S
            const firstSlotAddr = frame.entrySpBefore - S;
            const slotEl = slotEls.get(firstSlotAddr);
            if (!slotEl) continue;
            const rect = slotEl.getBoundingClientRect();
            const top = rect.top - colTop + rect.height / 2;
            html += `<span class="flabel" style="top:${top}px">${frame.label}</span>`;
        }
        if (redZoneEl) {
            const rect = redZoneEl.getBoundingClientRect();
            const top = rect.top - colTop + rect.height / 2;
            html += `<span class="flabel flabel-faint" style="top:${top}px">${$_("stack.red_zone")}</span>`;
        }
        labelsEl.innerHTML = html;
    }

    function positionOffsets(_step: Step, _sp: number) {
        if (!offsetsEl || !wrapperEl) return;
        const wTop = wrapperEl.getBoundingClientRect().top;
        let html = "";
        for (const [addr, el] of slotEls) {
            const opacity = parseFloat(el.style.opacity || "1");
            if (slotMode(addr) !== S) {
                const subSlotDivs = el.querySelectorAll('.sub-slot');
                subSlotDivs.forEach((subEl) => {
                    const subAddr = parseInt(subEl.getAttribute('data-addr') ?? '0', 10);
                    const offset = subAddr - _sp;
                    if (offset === 0 || Math.abs(offset) > OFFSET_MAX) return;
                    const sign = offset > 0 ? "+" : "";
                    const rect = subEl.getBoundingClientRect();
                    const top = rect.top - wTop + rect.height / 2;
                    html += `<div class="offset-arrow" style="top:${top}px;opacity:${opacity}">${spName}${sign}${offset}</div>`;
                });
            } else {
                const offset = addr - _sp;
                if (offset === 0) continue;
                if (Math.abs(offset) > OFFSET_MAX) continue;
                const sign = offset > 0 ? "+" : "";
                const rect = el.getBoundingClientRect();
                const top = rect.top - wTop + rect.height / 2;
                html += `<div class="offset-arrow" style="top:${top}px;opacity:${opacity}">${spName}${sign}${offset}</div>`;
            }
        }
        offsetsEl.innerHTML = html;
    }

    function getSlotMemVal(addr: number): bigint | undefined {
        if (!step?.mem) return undefined;
        return readWritten(step.mem, addr, S);
    }

    const slotKey = (addr: number) => `stack-${addr.toString(16)}`;

    // Piece size a slot is shown as: the user's choice, else split to fit the
    // smallest value stored in it (an 8-byte slot holding two 4-byte ints).
    function slotMode(addr: number): number {
        const chosen = ui.slotViewMode.get(slotKey(addr));
        if (chosen !== undefined) return chosen;
        let size: number = S;
        for (let off = 0; off < S; off++) {
            const label = sim.currentSlotLabels.get(addr + off);
            if (label) size = Math.min(size, label.size);
        }
        return size;
    }

    function setSlotMode(key: string, mode: number) {
        const next = new Map(ui.slotViewMode);
        next.set(key, mode);
        ui.slotViewMode = next;
    }

</script>

<div class="stack-area scrollable">
    {#if sim.loadError}
        {@const e = sim.loadError}
        <div class="config-error">
            <div class="config-error-title">{$_('stack.error_title')}</div>
            {#if e.message}
                <p>{e.message}</p>
            {/if}
            {#if e.detail}
                <p class="config-error-hint">{e.detail}</p>
            {/if}
        </div>
    {:else if sim.inferError && sim.cur >= sim.inferError.step}
        <div class="config-error">
            <div class="config-error-title">{$_('stack.non_stack_title')}</div>
            <p>{sim.inferError.message}</p>
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
                <span class="fp-label">{sim.isa.regs.fpLabel}</span>
                <span class="fp-arrow-shaft"></span>
                <span class="fp-arrow-head"></span>
            </div>

            <!-- SP arrow -->
            <div class="sp-arrow" bind:this={spArrowEl}>
                <span class="sp-label">{spName}</span>
                <span class="sp-arrow-shaft"></span>
                <span class="sp-arrow-head"></span>
            </div>

            <!-- Stack column -->
            <div class="stack-column" bind:this={columnEl}>
                <!-- Caller ghost (above) -->
                <div class="frame caller" id="fr-caller">
                    <div class="frame-ellipsis">
                        <div>{$_('stack.high_address')}</div>
                        <div>↑</div>
                    </div>
                    {#each callerGhostRows as row}
                        {@const key = slotKey(row.addr)}
                        {@const mode = slotMode(row.addr)}
                        {@const gWord = garbageMem(row.addr, S)}
                        {@const memVal = getSlotMemVal(row.addr)}
                        <div
                            class="frame-slot"
                            id="slot-{row.addr.toString(16)}"
                            style="opacity:{row.opacity}"
                            use:registerSlotAction={row.addr}
                        >
                            <StackSlot
                                size={S}
                                addr={row.addr}
                                {mode}
                                {memVal}
                                {gWord}
                                labels={sim.currentSlotLabels}
                                disabled={!ui.showGarbage && memVal === undefined}
                                onModeChange={(m) => setSlotMode(key, m)}
                            />
                        </div>
                    {/each}
                </div>

                <!-- Active frames -->
                {#each activeFrames as frame, fi}
                    {@const color = FRAME_COLORS[fi % FRAME_COLORS.length]}
                    {@const frameTop = frame.entrySpBefore}
                    {@const frameBot =
                        frame.entrySpBefore - frame.allocatedSize}
                    {@const frameSlots = Array.from(
                        { length: (frameTop - frameBot) / S },
                        (_, i) => frameTop - S - i * S,
                    )}
                    <div
                        class="frame"
                        id="fr-active-{fi}"
                        data-label={frame.label}
                    >
                        {#each frameSlots as addr}
                            {@const memVal = getSlotMemVal(addr)}
                            {@const key = slotKey(addr)}
                            {@const mode = slotMode(addr)}
                            <!-- A split slot flashes only its accessed pieces (in StackSlot). -->
                            {@const isHi = hiS.has(addr) && mode === S}
                            {@const gWord = garbageMem(addr, S)}
                            <div
                                class="frame-slot"
                                class:hi={isHi}
                                id="slot-{addr.toString(16)}"
                                style="background:{color}"
                                use:registerSlotAction={addr}
                            >
                                <StackSlot
                                    size={S}
                                    {addr}
                                    {mode}
                                    {memVal}
                                    {gWord}
                                    labels={sim.currentSlotLabels}
                                    disabled={!ui.showGarbage && memVal === undefined}
                                    onModeChange={(m) => setSlotMode(key, m)}
                                />
                            </div>
                        {/each}
                    </div>
                {/each}

                <!-- Red zone: in use below sp -->
                {#if redZoneRows.length}
                    <div class="frame red-zone" bind:this={redZoneEl}>
                        {#each redZoneRows as addr}
                            {@const memVal = getSlotMemVal(addr)}
                            {@const key = slotKey(addr)}
                            <div
                                class="frame-slot"
                                class:hi={hiS.has(addr) && slotMode(addr) === S}
                                id="slot-{addr.toString(16)}"
                                use:registerSlotAction={addr}
                            >
                                <StackSlot
                                    size={S}
                                    {addr}
                                    mode={slotMode(addr)}
                                    {memVal}
                                    gWord={garbageMem(addr, S)}
                                    labels={sim.currentSlotLabels}
                                    disabled={!ui.showGarbage && memVal === undefined}
                                    onModeChange={(m) => setSlotMode(key, m)}
                                />
                            </div>
                        {/each}
                    </div>
                {/if}

                <!-- Free zone (below sp) -->
                <div class="frame free" id="fr-free">
                    {#each freeGhostRows as row}
                        {@const key = slotKey(row.addr)}
                        {@const mode = slotMode(row.addr)}
                        {@const gWord = garbageMem(row.addr, S)}
                        {@const memVal = getSlotMemVal(row.addr)}
                        <div
                            class="frame-slot"
                            style="opacity:{row.opacity};background:var(--bg);border-top-style:dashed"
                            use:registerSlotAction={row.addr}
                        >
                            <StackSlot
                                size={S}
                                addr={row.addr}
                                {mode}
                                {memVal}
                                {gWord}
                                faint={true}
                                disabled={true}
                                onModeChange={(m) => setSlotMode(key, m)}
                            />
                        </div>
                    {/each}
                    <div class="frame-ellipsis">
                        <div>↓</div>
                        <div>{$_('stack.low_address')}</div>
                    </div>
                </div>
            </div>

            <!-- Frame labels (right of stack) -->
            <div class="frame-labels" bind:this={labelsEl}></div>
        </div>
    {/if}
</div>

<style>
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
        gap: 16px;
        background: var(--surface);
        position: relative;
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
    /* In use, but below sp: dashed and hatched to set it apart from a frame */
    .frame.red-zone .frame-slot {
        border-top-style: dashed;
        background: repeating-linear-gradient(
            -45deg,
            var(--red-dim) 0 6px,
            transparent 6px 12px
        );
    }
    :global(.flabel-faint) {
        color: var(--text-faint);
        font-style: italic;
    }
    .frame.free .frame-ellipsis {
        border-bottom: none;
    }
    .frame.free .frame-slot {
        background: var(--bg);
        border-top-style: dashed;
        pointer-events: none;
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
