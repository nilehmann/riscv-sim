<script lang="ts">
    import type { AssemblyResult, Concrete, SourceInstr } from "./types";
    import { fmtAddr } from "./types";
    import { sim, ui } from "./state.svelte";
    import Tokens from "./Tokens.svelte";
    import EncodingPopover from "./EncodingPopover.svelte";
    import Popover from "./Popover.svelte";
    import { _ } from "svelte-i18n";

    // ─── HTML escape (used by highlightC) ─────────────────────────────────

    function esc(s: string): string {
        return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    // ─── Garbage instructions (before/after the visible program) ──────────
    // Deterministic filler rows showing arbitrary code exists at nearby
    // addresses too — same idea as garbage register/memory defaults.

    interface GarbageRow {
        tier: "near" | "far";
        c: Concrete;
    }

    function garbageAt(seed: number): { instr: unknown; size: number } {
        const instr = sim.isa.garbage(seed);
        return { instr, size: sim.isa.size(instr) };
    }

    // Rendered top-to-bottom: farthest first, nearest last (right above real code).
    // Built backwards so the nearest one ends exactly where the code starts.
    const garbageBefore = $derived.by((): GarbageRow[] => {
        const first = sim.assembled?.sourceInstrs[0]?.firstAddr;
        if (first == null) return [];
        const rows: GarbageRow[] = [];
        let end = first;
        for (let i = 0; i < 2; i++) {
            const { instr, size } = garbageAt(end);
            end -= size;
            rows.unshift({ tier: i === 0 ? "near" : "far", c: { instr, addr: end, size } });
        }
        return rows;
    });

    // Rendered top-to-bottom: nearest first (right after real code), farthest last.
    const garbageAfter = $derived.by((): GarbageRow[] => {
        if (!sim.assembled || sim.assembled.sourceInstrs.length === 0) return [];
        const rows: GarbageRow[] = [];
        let addr = sim.assembled.endAddr;
        for (let i = 0; i < 2; i++) {
            const { instr, size } = garbageAt(addr);
            rows.push({ tier: i === 0 ? "near" : "far", c: { instr, addr, size } });
            addr += size;
        }
        return rows;
    });

    // ─── C syntax highlighter ─────────────────────────────────────────────

    const C_KEYWORDS = new Set([
        "int","char","float","double","long","short","unsigned","signed","void",
        "return","if","else","while","for","do","break","continue","switch",
        "case","default","struct","union","typedef","static","const","extern",
        "sizeof","enum",
    ]);

    function highlightC(code: string): string {
        let out = "";
        let i = 0;
        while (i < code.length) {
            if (code[i] === "/" && code[i + 1] === "*") {
                const end = code.indexOf("*/", i + 2);
                const val = end === -1 ? code.slice(i) : code.slice(i, end + 2);
                out += `<span class="cmt">${esc(val)}</span>`;
                i += val.length;
                continue;
            }
            if (code[i] === "/" && code[i + 1] === "/") {
                const end = code.indexOf("\n", i);
                const val = end === -1 ? code.slice(i) : code.slice(i, end);
                out += `<span class="cmt">${esc(val)}</span>`;
                i += val.length;
                continue;
            }
            if (code[i] === '"') {
                let j = i + 1;
                while (j < code.length && code[j] !== '"') { if (code[j] === "\\") j++; j++; }
                out += `<span class="reg">${esc(code.slice(i, j + 1))}</span>`;
                i = j + 1;
                continue;
            }
            if (code[i] === "'") {
                let j = i + 1;
                while (j < code.length && code[j] !== "'") { if (code[j] === "\\") j++; j++; }
                out += `<span class="reg">${esc(code.slice(i, j + 1))}</span>`;
                i = j + 1;
                continue;
            }
            if (/[a-zA-Z_]/.test(code[i]!)) {
                let j = i;
                while (j < code.length && /\w/.test(code[j]!)) j++;
                const word = code.slice(i, j);
                let k = j;
                while (k < code.length && code[k] === " ") k++;
                if (code[k] === "(") out += `<span class="fn">${esc(word)}</span>`;
                else if (C_KEYWORDS.has(word)) out += `<span class="kw">${esc(word)}</span>`;
                else out += esc(word);
                i = j;
                continue;
            }
            if (/[0-9]/.test(code[i]!)) {
                let j = i;
                while (j < code.length && /[0-9a-fA-FxX.]/.test(code[j]!)) j++;
                out += `<span class="imm">${esc(code.slice(i, j))}</span>`;
                i = j;
                continue;
            }
            out += esc(code[i]!);
            i++;
        }
        return out;
    }

    // ─── Info icon SVG ────────────────────────────────────────────────────

    const INFO_SVG =
        `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" ` +
        `fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
        `<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line>` +
        `<line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;


    // ─── Line groups: label headers + source instrs (computed from assembled)

    interface SourceGroup {
        labels: string[];  // label lines to show before this instruction
        si: SourceInstr;
    }

    function buildGroups(assembled: AssemblyResult): SourceGroup[] {
        return assembled.sourceInstrs.map((si) => ({ labels: si.labels, si }));
    }

    // ─── Reactive highlights: addresses → hl/next-instr classes ──────────
    // We manage these imperatively via $effect since we need debounce timing.

    let hlTimeout: ReturnType<typeof setTimeout> | null = null;
    let nextInstrTimeout: ReturnType<typeof setTimeout> | null = null;

    // Current highlighted addresses (remapped to source first-addr in source mode)
    const hlAddrs = $derived.by(() => {
        const step = sim.currentStep;
        if (!step) return [] as number[];
        if (sim.asmMode === "source" && sim.assembled) {
            return (step.aHl ?? []).map((addr) => {
                const idx = sim.assembled!.addrToSourceIdx.get(addr);
                return idx != null ? sim.assembled!.sourceInstrs[idx]!.firstAddr : addr;
            });
        }
        return step.aHl ?? [];
    });

    const nextAddr = $derived(sim.currentStep?.nextAddr ?? null);

    $effect(() => {
        // Touch reactive dependencies
        const _hl = hlAddrs;
        const _next = nextAddr;
        const _cur = sim.cur;

        // Clear previous state
        clearTimeout(hlTimeout ?? undefined);
        clearTimeout(nextInstrTimeout ?? undefined);
        document.querySelectorAll(".line.hl").forEach((el) => el.classList.remove("hl"));
        document.querySelectorAll(".line.next-instr").forEach((el) => el.classList.remove("next-instr"));

        // Apply highlights
        for (const addr of _hl) {
            const el = document.getElementById("al-" + addr.toString(16));
            if (el) {
                el.classList.add("hl");
                el.scrollIntoView({ block: "nearest", behavior: "smooth" });
            }
        }
        if (_hl.length > 0) {
            hlTimeout = setTimeout(() => {
                document.querySelectorAll(".line.hl").forEach((el) => el.classList.remove("hl"));
            }, 400);
        }

        // Apply next-instruction arrow
        const applyNextInstr = () => {
            if (_next != null) {
                const el = document.getElementById("al-" + _next.toString(16));
                if (el) {
                    el.classList.add("next-instr");
                    if (_hl.length === 0) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
                }
            }
        };
        if (_hl.length > 0) {
            nextInstrTimeout = setTimeout(applyNextInstr, 400);
        } else {
            applyNextInstr();
        }

        return () => {
            clearTimeout(hlTimeout ?? undefined);
            clearTimeout(nextInstrTimeout ?? undefined);
        };
    });

    // ─── Reactive derived data ────────────────────────────────────────────
    const groups = $derived(
        sim.assembled ? buildGroups(sim.assembled) : [],
    );

    const cHtml = $derived(
        sim.program?.cCode ? highlightC(sim.program.cCode) : "",
    );

    // ─── Machine view: bytes per row, encoding popover on hover/click ─────

    // Longer instructions wrap onto byte-only lines, as in objdump.
    const BYTES_PER_LINE = 4;

    function hexBytes(c: Concrete): string[] {
        return sim.isa.encode(c.instr).bytes.map((b) =>
            b.toString(16).toUpperCase().padStart(2, "0"),
        );
    }

    // Real instructions by address, with the source line each came from
    // (garbage rows are not hoverable).
    const machineInstrs = $derived.by(() => {
        const m = new Map<number, { c: Concrete; si: SourceInstr }>();
        for (const si of sim.assembled?.sourceInstrs ?? [])
            for (const c of si.concretes) m.set(c.addr, { c, si });
        return m;
    });

    // Row popover (Source: expanded instructions; Machine: encoding). Hovering
    // the info icon opens it, and it stays open while the pointer is on the icon
    // or the popover (a short delay lets it cross the gap). In Machine view,
    // clicking the icon pins it until unpinned, clicked outside, or Esc.
    let hoverAddr = $state<number | null>(null);
    let pinnedAddr = $state<number | null>(null);
    const popAddr = $derived(pinnedAddr ?? hoverAddr);
    let hideTimer: ReturnType<typeof setTimeout> | undefined;

    function showPopover(addr: number) {
        clearTimeout(hideTimer);
        hoverAddr = addr;
    }
    function keepPopover() {
        clearTimeout(hideTimer);
    }
    function hidePopoverSoon() {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => (hoverAddr = null), 150);
    }
    function togglePin(addr: number) {
        pinnedAddr = pinnedAddr === addr ? null : addr;
    }

    function onWindowPointerDown(e: PointerEvent) {
        if (pinnedAddr == null) return;
        // Info icons handle their own clicks; the popover itself is interactive.
        if ((e.target as Element | null)?.closest(".row-info, .popover")) return;
        pinnedAddr = null;
    }
    function onWindowKeyDown(e: KeyboardEvent) {
        if (e.key === "Escape") pinnedAddr = null;
    }

    // Rows are replaced on mode switch or program load without a mouseleave.
    $effect(() => {
        sim.asmMode;
        sim.assembled;
        clearTimeout(hideTimer);
        hoverAddr = null;
        pinnedAddr = null;
    });

    const popEntry = $derived(popAddr != null ? (machineInstrs.get(popAddr) ?? null) : null);
    const popSource = $derived.by(() => {
        if (popAddr == null || !sim.assembled) return null;
        const idx = sim.assembled.addrToSourceIdx.get(popAddr);
        return idx != null ? sim.assembled.sourceInstrs[idx]! : null;
    });

    // A source line is a pseudo-instruction if it expanded to something else.
    function isPseudo(si: SourceInstr): boolean {
        return sim.isa.isPseudo(si.parsed, si.concretes.map((c) => c.instr));
    }

    // Bumped on scroll/resize so the popover follows its row.
    let layoutTick = $state(0);
    const popAnchor = $derived.by(() => {
        layoutTick;
        if (popAddr == null) return null;
        const row = document.getElementById("al-" + popAddr.toString(16));
        if (!row) return null;
        // Rows can be wider than the panel when it scrolls horizontally.
        const panelRight = row.closest(".code-scroll")!.getBoundingClientRect().right;
        const r = row.getBoundingClientRect();
        return { x: Math.min(r.right, panelRight), y: r.top };
    });
</script>

<svelte:window
    onresize={() => layoutTick++}
    onpointerdown={onWindowPointerDown}
    onkeydown={onWindowKeyDown}
/>

<!-- LEFT: Assembly / C panel -->
<div class="code-panel">
    <!-- Tab bar -->
    <div class="code-tabs">
        <button
            class="code-tab"
            class:active={ui.activeTab === "asm"}
            onclick={() => (ui.activeTab = "asm")}
        >{$_('code_panel.tab_assembly')}</button>
        <button
            class="code-tab"
            class:active={ui.activeTab === "c"}
            disabled={!sim.program?.cCode}
            onclick={() => (ui.activeTab = "c")}
        >{$_('code_panel.tab_c')}</button>
    </div>

    <!-- Assembly pane -->
    {#if ui.activeTab === "asm"}
        <div class="code-scroll scrollable" onscroll={() => layoutTick++}>
            <!-- Mode bar -->
            <div class="asm-mode-bar">
                <button
                    class="asm-mode-btn"
                    class:active={sim.asmMode === "source"}
                    onclick={() => sim.switchAsmMode("source")}
                >{$_('code_panel.mode_source')}</button>
                <button
                    class="asm-mode-btn"
                    class:active={sim.asmMode === "machine"}
                    onclick={() => sim.switchAsmMode("machine")}
                >{$_('code_panel.mode_machine')}</button>
            </div>

            <!-- Assembly lines -->
            {#if sim.assembled}
                <div id="view-asm">
                    {#snippet labelRow(label: string)}
                        <div class="line">
                            <span class="asm-addr"></span>
                            <span class="lbl">{label}:</span>
                        </div>
                    {/snippet}
                    {#snippet garbageRow(g: GarbageRow)}
                        <div class="line garbage garbage-{g.tier}" id="al-{g.c.addr.toString(16)}">
                            <span class="pc-arrow">▶</span>
                            <span class="asm-addr">{fmtAddr(g.c.addr)}</span>
                            <span class="instr-span"><Tokens tokens={sim.isa.tokens(g.c.instr, g.c.addr)} /></span>
                        </div>
                    {/snippet}
                    {#snippet machineRow(c: Concrete, extraClass: string)}
                        {@const addr = c.addr}
                        <div
                            class="line machine-row {extraClass}"
                            class:multi-line={c.size > BYTES_PER_LINE}
                            class:enc-open={popAddr === addr}
                            class:enc-pinned={pinnedAddr === addr}
                            id="al-{addr.toString(16)}"
                        >
                            <span class="pc-arrow">▶</span>
                            <span class="asm-addr">{fmtAddr(addr)}</span>
                            <span class="instr-span mc-bytes">
                                {#each hexBytes(c) as b}<span>{b}</span>{/each}
                            </span>
                            <span class="mc-instr"><Tokens tokens={sim.isa.tokens(c.instr, addr)} /></span>
                            {#if !extraClass.includes("garbage")}
                                <!-- Hover (or focus) shows the encoding popover, click pins it -->
                                <button
                                    class="row-info"
                                    aria-label={$_("encoding.show")}
                                    aria-pressed={pinnedAddr === addr}
                                    onclick={() => togglePin(addr)}
                                    onmouseenter={() => showPopover(addr)}
                                    onmouseleave={hidePopoverSoon}
                                    onfocus={() => showPopover(addr)}
                                    onblur={hidePopoverSoon}
                                >{@html INFO_SVG}</button>
                            {/if}
                        </div>
                    {/snippet}
                    {#if sim.asmMode === "source"}
                        <!-- Source view: one row per source instruction -->
                        {#each garbageBefore as g}{@render garbageRow(g)}{/each}
                        {#each groups as { labels, si }}
                            {#each labels as label}{@render labelRow(label)}{/each}
                            <div
                                class="line"
                                class:enc-open={popAddr === si.firstAddr}
                                id="al-{si.firstAddr.toString(16)}"
                            >
                                <span class="pc-arrow">▶</span>
                                <span class="asm-addr">{fmtAddr(si.firstAddr)}</span>
                                <span class="instr-span"><Tokens tokens={sim.isa.sourceTokens(si.parsed, si.raw, sim.assembled!.labels)} /></span>
                                <!-- Hover (or focus) shows what this line assembles to -->
                                <button
                                    class="row-info"
                                    aria-label={$_("code_panel.show_expansion")}
                                    onmouseenter={() => showPopover(si.firstAddr)}
                                    onmouseleave={hidePopoverSoon}
                                    onfocus={() => showPopover(si.firstAddr)}
                                    onblur={hidePopoverSoon}
                                >{@html INFO_SVG}</button>
                            </div>
                        {/each}
                        {#each sim.assembled.trailingLabels as label}{@render labelRow(label)}{/each}
                        {#each garbageAfter as g}{@render garbageRow(g)}{/each}
                    {:else}
                        <!-- Machine view: little-endian bytes of each concrete instruction -->
                        {#each garbageBefore as g}{@render machineRow(g.c, `garbage garbage-${g.tier}`)}{/each}
                        {#each groups as { labels, si }}
                            {#each labels as label}{@render labelRow(label)}{/each}
                            {#if si.concretes.length === 1}
                                {@render machineRow(si.concretes[0]!, "")}
                            {:else}
                                <div class="concrete-group">
                                    {#each si.concretes as c}
                                        {@render machineRow(c, "")}
                                    {/each}
                                </div>
                            {/if}
                        {/each}
                        {#each sim.assembled.trailingLabels as label}{@render labelRow(label)}{/each}
                        {#each garbageAfter as g}{@render machineRow(g.c, `garbage garbage-${g.tier}`)}{/each}
                    {/if}
                </div>
            {/if}
        </div>
    {:else}
        <!-- C pane -->
        <div class="code-scroll scrollable">
            <pre class="c-view">{@html cHtml}</pre>
        </div>
    {/if}
</div>

{#if sim.asmMode === "machine" && popAddr != null && popEntry && popAnchor}
    <EncodingPopover
        concrete={popEntry.c}
        pseudo={isPseudo(popEntry.si) ? popEntry.si : null}
        labels={sim.assembled?.labels ?? {}}
        anchor={popAnchor}
        pinned={pinnedAddr != null}
        onenter={keepPopover}
        onleave={hidePopoverSoon}
        onclose={() => (pinnedAddr = null)}
    />
{:else if sim.asmMode === "source" && popAddr != null && popSource && popAnchor}
    <Popover anchor={popAnchor} onenter={keepPopover} onleave={hidePopoverSoon}>
        <div class="expansion">
            {#each popSource.concretes as c}
                <div><Tokens tokens={sim.isa.tokens(c.instr, c.addr)} /></div>
            {/each}
        </div>
    </Popover>
{/if}

<style>
    .code-panel {
        border-right: 1px solid var(--border);
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }
    .code-scroll {
        flex: 1;
        overflow: auto;
    }
    /* Rows share the width of the longest one, so long lines scroll
       horizontally together and highlights span the full row. */
    #view-asm {
        width: max-content;
        min-width: 100%;
    }
    .code-tabs {
        display: flex;
        border-bottom: 1px solid var(--border);
        background: var(--surface);
        flex-shrink: 0;
    }
    .code-tab {
        font-family: var(--mono);
        font-size: 14px;
        padding: 7px 16px;
        cursor: pointer;
        border: none;
        background: none;
        color: var(--text-dim);
        border-bottom: 2px solid transparent;
        margin-bottom: -1px;
    }
    .code-tab.active {
        color: var(--text);
        border-bottom-color: var(--blue);
    }
    .code-tab:disabled {
        opacity: 0.35;
        cursor: default;
    }
    .asm-mode-bar {
        position: sticky;
        left: 0;
        display: flex;
        align-items: center;
        padding: 7px 12px;
        border-bottom: 1px solid var(--border);
        background: var(--surface);
        flex-shrink: 0;
    }
    .asm-mode-btn {
        font-family: var(--mono);
        font-size: 13px;
        padding: 3px 12px;
        border: none;
        background: var(--surface2);
        color: var(--text-dim);
        cursor: pointer;
        line-height: 1.6;
        transition: background 0.15s, color 0.15s;
    }
    .asm-mode-btn:first-child {
        border-radius: 999px 0 0 999px;
    }
    .asm-mode-btn:last-child {
        border-radius: 0 999px 999px 0;
    }
    .asm-mode-btn.active {
        background: var(--text);
        color: var(--bg);
    }
    /* .line, .asm-addr, .pc-arrow, syntax colors, etc. must be global
       because they are applied to elements inside {#if} blocks and
       are also targeted by the imperative $effect highlight logic */
    :global(.line) {
        font-family: var(--mono);
        font-size: 18px;
        line-height: 1.8;
        padding: 0 8px;
        display: flex;
        align-items: center;
        white-space: pre;
        transition: background 0.25s, border-color 0.25s;
        border-left: 2px solid transparent;
        position: relative;
    }
    :global(.line.hl) {
        background: rgba(9, 105, 218, 0.07);
        border-left-color: var(--blue);
        transition: none;
    }
    :global(.line.next-instr .pc-arrow) {
        opacity: 1;
    }
    :global(.line.target-hl) {
        background: var(--purple-dim);
        border-left-color: var(--purple);
        transition: none;
    }
    :global(.pc-arrow) {
        display: inline-block;
        width: 16px;
        text-align: center;
        color: var(--blue);
        font-size: 14px;
        user-select: none;
        flex-shrink: 0;
        opacity: 0;
        transition: opacity 0.2s ease;
    }
    :global(.asm-addr) {
        color: var(--text-faint);
        font-size: 14px;
        min-width: 72px;
        margin-right: 6px;
        user-select: none;
    }
    :global(.instr-span) {
        margin-left: 4px;
    }
    :global(.lbl) {
        color: var(--blue);
        font-weight: 600;
    }
    :global(.kw) { color: var(--red); }
    :global(.reg) { color: var(--green); }
    :global(.imm) { color: var(--orange); }
    :global(.fn) { color: var(--purple); }
    :global(.cmt) { color: var(--text-faint); font-style: italic; }
    :global([data-target-addr]) {
        cursor: pointer;
        text-decoration: underline dotted currentColor;
        text-underline-offset: 2px;
    }
    :global(.concrete-group) {
        border: 1px solid var(--border);
        border-radius: 6px;
        /* clip, not hidden: hidden makes this a scroll container, which would
           stop the sticky info icons inside it from sticking to the panel. */
        overflow: clip;
        margin: 2px 4px;
        position: relative;
    }
    /* 4px margin + 1px border + 3px padding lines up with the 8px row padding */
    :global(.concrete-group .line) {
        padding-left: 3px;
        padding-right: 3px;
    }
    :global(.line.garbage) {
        pointer-events: none;
        user-select: none;
    }
    :global(.line.machine-row) {
        /* children use smaller fonts; keep the same row height as other modes */
        min-height: 1.8em;
    }
    /* Always 4 bytes wide, so instruction text lines up across rows */
    .mc-bytes {
        display: grid;
        grid-template-columns: repeat(4, 2ch);
        column-gap: 4px;
        font-size: 16px;
        flex-shrink: 0;
    }
    /* Line up the address and instruction with the first line of bytes */
    :global(.line.machine-row.multi-line) {
        align-items: baseline;
    }
    :global(.line.machine-row.multi-line) .mc-bytes {
        line-height: 1.5;
        padding: 4px 0;
    }
    .mc-instr {
        font-size: 14px;
        margin-left: 12px;
        flex-shrink: 0;
    }
    /* margin-left: auto pushes it to the row's right edge; sticky keeps it at
       the panel's visible edge when the row overflows, with the text scrolling
       under a short fade. */
    .row-info {
        margin-left: auto;
        position: sticky;
        right: 0;
        padding: 0 0 0 12px;
        display: flex;
        align-items: center;
        /* Opaque base plus the row's own tint, so it blends with highlighted rows */
        background:
            linear-gradient(to right, transparent, var(--row-tint, transparent) 10px),
            linear-gradient(to right, transparent, var(--bg) 10px);
        border: none;
        color: var(--text-faint);
        cursor: pointer;
        opacity: 0;
        transition: opacity 0.15s;
    }
    :global(.line:hover) .row-info,
    :global(.line.enc-open) .row-info {
        opacity: 1;
    }
    .row-info:hover {
        color: var(--text-dim);
    }
    :global(.line.enc-pinned) .row-info {
        color: var(--blue);
    }
    :global(.line.enc-open) {
        --row-tint: var(--blue-dim);
        background: var(--row-tint);
    }
    :global(.line.garbage-near) {
        opacity: 0.3;
    }
    :global(.line.garbage-far) {
        opacity: 0.08;
    }
    .expansion {
        font-size: 16px;
        line-height: 1.7;
        white-space: pre;
    }
    .c-view {
        font-family: var(--mono);
        font-size: 16px;
        line-height: 1.7;
        padding: 16px;
        color: var(--text);
        white-space: pre-wrap;
    }
    .scrollable::-webkit-scrollbar { width: 4px; height: 4px; }
    .scrollable::-webkit-scrollbar-track { background: transparent; }
    .scrollable::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
</style>
