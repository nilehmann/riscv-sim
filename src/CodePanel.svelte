<script lang="ts">
    import type { AssemblyResult, SourceInstr } from "./types";
    import { sim, ui } from "./state.svelte";
    import { hx, fmtConcreteRel } from "./assembler";
    import { REG_SET } from "./simulator";

    // ─── Constants ────────────────────────────────────────────────────────
    const JUMP_OPS = new Set(["jal", "beq", "bne", "blt", "bge", "bltu", "bgeu"]);

    // ─── Highlight logic (produces HTML strings for {@html}) ─────────────

    function esc(s: string): string {
        return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    function hlInstrHtml(raw: string, labels: Record<string, number>, addr: number): string {
        const s = raw.trim();
        const spIdx = s.indexOf(" ");
        const op = spIdx === -1 ? s : s.slice(0, spIdx);
        const rest = spIdx === -1 ? "" : s.slice(spIdx + 1);
        const isJump = JUMP_OPS.has(op);

        let out = `<span class="kw">${esc(op)}</span>`;
        if (!rest) return out;

        const makeToken = (tok: string, isLast: boolean): string => {
            const t = tok.trim();
            const memM = t.match(/^(-?\d+)\((\w+)\)$/);
            if (memM) return `<span class="imm">${esc(memM[1]!)}</span>(` +
                `<span class="reg">${esc(memM[2]!)}</span>)`;
            if (REG_SET.has(t)) return `<span class="reg">${esc(t)}</span>`;
            if (/^[+-]?\d+$/.test(t)) {
                if (isJump && isLast) {
                    const targetAddr = addr + parseInt(t, 10);
                    return `<span class="fn" data-target-addr="${targetAddr}" data-tooltip="addr: ${hx(targetAddr)}">${esc(t)}</span>`;
                }
                return `<span class="imm">${esc(t)}</span>`;
            }
            if (t in labels) {
                const targetAddr = labels[t]!;
                return `<span class="fn" data-target-addr="${targetAddr}" data-tooltip="addr: ${hx(targetAddr)}">${esc(t)}</span>`;
            }
            return `<span class="fn">${esc(t)}</span>`;
        };

        const toks = rest.split(",");
        out += " ";
        toks.forEach((tok, i) => {
            out += makeToken(tok, i === toks.length - 1);
            if (i < toks.length - 1) out += ", ";
        });
        return out;
    }

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

    function infoIconHtml(tooltip: string): string {
        return `<span class="instr-info" data-tooltip="${esc(tooltip)}">` +
            `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" ` +
            `fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
            `<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line>` +
            `<line x1="12" y1="8" x2="12.01" y2="8"></line></svg></span>`;
    }

    // ─── Assembled view line groups (computed from assembled) ─────────────

    interface SourceGroup {
        label: string | null;  // label to show before this group, if changed
        si: SourceInstr;
    }

    function buildGroups(assembled: AssemblyResult): SourceGroup[] {
        const groups: SourceGroup[] = [];
        let lastLabel: string | null = null;
        for (const si of assembled.sourceInstrs) {
            const labelChanged = si.label !== lastLabel;
            groups.push({ label: labelChanged ? si.label : null, si });
            lastLabel = si.label;
        }
        return groups;
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
</script>

<!-- LEFT: Assembly / C panel -->
<div class="code-panel">
    <!-- Tab bar -->
    <div class="code-tabs">
        <button
            class="code-tab"
            class:active={ui.activeTab === "asm"}
            onclick={() => (ui.activeTab = "asm")}
        >Assembly</button>
        <button
            class="code-tab"
            class:active={ui.activeTab === "c"}
            disabled={!sim.program?.cCode}
            onclick={() => (ui.activeTab = "c")}
        >C</button>
    </div>

    <!-- Assembly pane -->
    {#if ui.activeTab === "asm"}
        <div class="code-scroll scrollable">
            <!-- Mode bar -->
            <div class="asm-mode-bar">
                <button
                    class="asm-mode-btn"
                    class:active={sim.asmMode === "source"}
                    onclick={() => sim.switchAsmMode("source")}
                >Fuente</button>
                <button
                    class="asm-mode-btn"
                    class:active={sim.asmMode === "assembled"}
                    onclick={() => sim.switchAsmMode("assembled")}
                >Ensamblado</button>
            </div>

            <!-- Assembly lines -->
            {#if sim.assembled}
                <div id="view-asm">
                    {#if sim.asmMode === "source"}
                        <!-- Source view: one row per source instruction -->
                        {#each groups as { label, si }}
                            {#if label !== null}
                                <div class="line">
                                    <span class="asm-addr"></span>
                                    <span class="lbl">{label}:</span>
                                </div>
                            {/if}
                            {@const tipContent = si.concretes.map((c, i) =>
                                fmtConcreteRel(c, si.firstAddr + i * 4)
                            ).join("\n")}
                            {@const instrHtml = hlInstrHtml(si.raw, sim.assembled!.labels, si.firstAddr)}
                            <div class="line" id="al-{si.firstAddr.toString(16)}">
                                <span class="pc-arrow">▶</span>
                                <span class="asm-addr">{hx(si.firstAddr)}</span>
                                <span class="instr-span">  {@html instrHtml}</span>
                                {@html infoIconHtml(tipContent)}
                            </div>
                        {/each}
                    {:else}
                        <!-- Assembled view: concrete instructions, pseudo-instructions expanded -->
                        {#each groups as { label, si }}
                            {#if label !== null}
                                {#if groups.indexOf({ label, si }) > 0}
                                    <div class="line">
                                        <span class="asm-addr"></span>
                                        &nbsp;
                                    </div>
                                {/if}
                                <div class="line">
                                    <span class="asm-addr"></span>
                                    <span class="lbl">{label}:</span>
                                </div>
                            {/if}
                            {#if si.concretes.length === 1}
                                {@const c = si.concretes[0]!}
                                {@const ciAddr = si.firstAddr}
                                {@const instrHtml = hlInstrHtml(fmtConcreteRel(c, ciAddr), sim.assembled!.labels, ciAddr)}
                                <div class="line" id="al-{ciAddr.toString(16)}">
                                    <span class="pc-arrow">▶</span>
                                    <span class="asm-addr">{hx(ciAddr)}</span>
                                    <span class="instr-span">  {@html instrHtml}</span>
                                    {@html infoIconHtml(si.raw)}
                                </div>
                            {:else}
                                <div class="concrete-group">
                                    {#each si.concretes as c, i}
                                        {@const ciAddr = si.firstAddr + i * 4}
                                        {@const instrHtml = hlInstrHtml(fmtConcreteRel(c, ciAddr), sim.assembled!.labels, ciAddr)}
                                        <div class="line" id="al-{ciAddr.toString(16)}">
                                            <span class="pc-arrow">▶</span>
                                            <span class="asm-addr">{hx(ciAddr)}</span>
                                            <span class="instr-span">  {@html instrHtml}</span>
                                        </div>
                                    {/each}
                                    {@html infoIconHtml(si.raw)}
                                </div>
                            {/if}
                        {/each}
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

<style>
    .code-panel {
        border-right: 1px solid var(--border);
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }
    .code-scroll {
        flex: 1;
        overflow-y: auto;
    }
    .code-tabs {
        display: flex;
        border-bottom: 1px solid var(--border);
        background: var(--surface);
        flex-shrink: 0;
    }
    .code-tab {
        font-family: var(--mono);
        font-size: 13px;
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
        display: flex;
        align-items: center;
        padding: 7px 12px;
        border-bottom: 1px solid var(--border);
        background: var(--surface);
        flex-shrink: 0;
    }
    .asm-mode-btn {
        font-family: var(--mono);
        font-size: 12px;
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
        font-size: 17px;
        line-height: 1.8;
        padding: 0 16px;
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
        font-size: 13px;
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
    :global(.instr-info) {
        position: absolute;
        right: 10px;
        top: 50%;
        transform: translateY(-50%);
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--text-faint);
        cursor: default;
        user-select: none;
        opacity: 0;
        transition: opacity 0.15s;
    }
    :global(.line:hover .instr-info),
    :global(.concrete-group:hover > .instr-info) {
        opacity: 1;
    }
    :global(.instr-info:hover) { color: var(--text-dim); }
    :global(.concrete-group) {
        border: 1px solid var(--border);
        border-radius: 6px;
        overflow: hidden;
        margin: 2px 8px;
        position: relative;
    }
    :global(.concrete-group > .instr-info) {
        top: 6px;
        transform: none;
    }
    :global(.concrete-group .line) {
        padding-left: 8px;
        padding-right: 8px;
    }
    .c-view {
        font-family: var(--mono);
        font-size: 15px;
        line-height: 1.7;
        padding: 16px;
        color: var(--text);
        white-space: pre-wrap;
    }
    .scrollable::-webkit-scrollbar { width: 4px; }
    .scrollable::-webkit-scrollbar-track { background: transparent; }
    .scrollable::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
</style>
