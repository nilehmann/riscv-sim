<script lang="ts">
    import { untrack } from "svelte";
    import { EditorView, basicSetup } from "codemirror";
    import { Compartment } from "@codemirror/state";
    import { StreamLanguage, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
    import { tags } from "@lezer/highlight";
    import { oneDark } from "@codemirror/theme-one-dark";
    import { vim } from "@replit/codemirror-vim";
    import type { Program } from "./types";
    import { ALL_REGS, isReg } from "./types";
    import { sim, ui } from "./state.svelte";

    // ── RISC-V language mode ──────────────────────────────────────────────────

    const REGISTERS = new Set<string>(ALL_REGS);
    const MNEMONICS = new Set([
        "add", "addi", "sub", "mul", "div", "rem",
        "and", "andi", "or", "ori", "xor", "xori",
        "sll", "slli", "srl", "srli", "sra", "srai",
        "lui", "auipc", "jal", "jalr", "ret", "nop",
        "beq", "bne", "blt", "bge", "bltu", "bgeu",
        "lw", "lh", "lb", "lhu", "lbu", "sw", "sh", "sb",
        "mv", "neg", "li", "la", "call", "tail", "j", "jr",
    ]);

    const riscvLang = StreamLanguage.define({
        token(stream) {
            if (stream.eatSpace()) return null;
            if (stream.match(/^#.*/) || stream.match(/^\/\/.*/)) return "comment";
            if (stream.match(/^-?0x[0-9a-fA-F]+/i) || stream.match(/^-?\d+/)) return "number";
            if (stream.match(/^[a-zA-Z_.][a-zA-Z0-9_.]*/)) {
                const word = stream.current();
                if (word.startsWith(".")) return "meta";
                if (stream.peek() === ":") return "def";
                if (REGISTERS.has(word)) return "builtin";
                if (MNEMONICS.has(word)) return "keyword";
                return "variable";
            }
            stream.next();
            return null;
        },
    });

    const riscvHighlight = HighlightStyle.define([
        { tag: tags.lineComment,                 color: "var(--text-faint)", fontStyle: "italic" },
        { tag: tags.number,                      color: "var(--blue)" },
        { tag: tags.keyword,                     color: "var(--purple)" },
        { tag: tags.standard(tags.variableName), color: "var(--orange)" },
        { tag: tags.definition(tags.labelName),  color: "var(--green)", fontWeight: "600" },
        { tag: tags.variableName,                color: "var(--text-dim)" },
        { tag: tags.meta,                        color: "var(--text-faint)" },
    ]);

    const structuralTheme = EditorView.theme({
        "&": { fontSize: "13px" },
        "&.cm-focused": { outline: "none" },
        ".cm-content": { fontFamily: "var(--mono)", caretColor: "var(--text)" },
        ".cm-gutters": { fontFamily: "var(--mono)" },
        ".cm-scroller": { lineHeight: "1.5" },
        ".cm-activeLine": { background: "rgba(128,128,128,0.05)" },
        ".cm-activeLineGutter": { background: "rgba(128,128,128,0.05)" },
    });

    const themeCompartment = new Compartment();
    const vimCompartment = new Compartment();
    const darkMQ = window.matchMedia("(prefers-color-scheme: dark)");

    function isDark(): boolean {
        if (ui.theme === "dark") return true;
        if (ui.theme === "light") return false;
        return darkMQ.matches;
    }

    let viewRef: EditorView | null = null;

    function syncTheme() {
        viewRef?.dispatch({
            effects: themeCompartment.reconfigure(isDark() ? oneDark : []),
        });
    }

    // ── Component state ───────────────────────────────────────────────────────

    let name = $state(sim.program?.name ?? "");
    let entryPoint = $state(sim.program?.entryPoint ?? "");
    let baseAddress = $state("0x" + (sim.program?.baseAddress ?? 0x8000).toString(16));
    let assembly = $state(sim.program?.assembly ?? "");
    let regs = $state<Array<{ reg: string; val: string }>>(
        Object.entries(sim.program?.initialRegs ?? { sp: 0xbfffff00, ra: 0x8050 }).map(
            ([reg, val]) => ({ reg, val: "0x" + val.toString(16) }),
        ),
    );
    let loadError = $state<string | null>(null);
    let editorContainer = $state<HTMLElement | null>(null);

    const regInvalidIdxs = $derived.by(() => {
        const seen = new Map<string, number>();
        const errors = new Set<number>();
        for (let i = 0; i < regs.length; i++) {
            const reg = regs[i]!.reg.trim();
            if (!isReg(reg)) {
                errors.add(i);
            } else if (seen.has(reg)) {
                errors.add(i);
                errors.add(seen.get(reg)!);
            } else {
                seen.set(reg, i);
            }
        }
        return errors;
    });

    $effect(() => {
        if (!editorContainer) return;
        const v = new EditorView({
            doc: untrack(() => assembly),
            extensions: [
                basicSetup,
                riscvLang,
                syntaxHighlighting(riscvHighlight),
                structuralTheme,
                themeCompartment.of(isDark() ? oneDark : []),
                vimCompartment.of(untrack(() => ui.vimMode) ? vim() : []),
                EditorView.updateListener.of((update) => {
                    if (update.docChanged) assembly = update.state.doc.toString();
                }),
            ],
            parent: editorContainer,
        });
        viewRef = v;
        darkMQ.addEventListener("change", syncTheme);
        return () => {
            darkMQ.removeEventListener("change", syncTheme);
            viewRef = null;
            v.destroy();
        };
    });

    $effect(() => {
        ui.theme; // track theme changes from settings
        syncTheme();
    });

    $effect(() => {
        ui.vimMode; // track vim mode changes from settings
        viewRef?.dispatch({
            effects: vimCompartment.reconfigure(ui.vimMode ? vim() : []),
        });
    });

    // ── Actions ───────────────────────────────────────────────────────────────

    function addReg() {
        const used = new Set(regs.map((r) => r.reg));
        const next = ALL_REGS.find((r) => !used.has(r)) ?? ALL_REGS[0]!;
        regs = [...regs, { reg: next, val: "0x0" }];
    }

    function removeReg(i: number) {
        regs = regs.filter((_, idx) => idx !== i);
    }

    function handleWrapperMousedown(e: MouseEvent) {
        if (!viewRef) return;
        if (!viewRef.contentDOM.contains(e.target as Node)) {
            e.preventDefault();
            viewRef.focus();
            viewRef.dispatch({
                selection: { anchor: viewRef.state.doc.length },
                scrollIntoView: true,
            });
        }
    }

    function load() {
        loadError = null;
        if (regInvalidIdxs.size > 0) {
            loadError = "Fix invalid register names before loading";
            return;
        }
        const parsedBase = parseInt(baseAddress);
        if (isNaN(parsedBase)) {
            loadError = "Invalid base address";
            return;
        }
        const initialRegs: Record<string, number> = {};
        for (const { reg, val } of regs) {
            const v = parseInt(val);
            if (isNaN(v)) {
                loadError = `Invalid value for ${reg}`;
                return;
            }
            initialRegs[reg] = v;
        }
        const prog: Program = { name, entryPoint: entryPoint.trim() || undefined, baseAddress: parsedBase, initialRegs, assembly };
        sim.loadProgram(prog);
        if (sim.loadError) {
            loadError = sim.loadError.message + (sim.loadError.detail ? `\n${sim.loadError.detail}` : "");
            return;
        }
        ui.showEditor = false;
    }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="backdrop" onclick={() => (ui.showEditor = false)}>
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="panel" onclick={(e) => e.stopPropagation()}>
        <div class="panel-header">
            <span class="panel-title">Edit Program</span>
            <button class="close-btn" onclick={() => (ui.showEditor = false)}>×</button>
        </div>

        <div class="panel-body">
            <!-- Name + entry point + base address row -->
            <div class="row2">
                <div class="field">
                    <label class="field-label">Name</label>
                    <input class="input" bind:value={name} placeholder="Program name" />
                </div>
                <div class="field">
                    <label class="field-label">Entry point</label>
                    <input class="input mono" bind:value={entryPoint} placeholder="optional — first instruction" />
                </div>
                <div class="field field-narrow">
                    <label class="field-label">Base address</label>
                    <input class="input mono" bind:value={baseAddress} placeholder="0x8000" />
                </div>
            </div>

            <!-- Assembly editor -->
            <div class="field">
                <label class="field-label">Assembly</label>
                <div class="asm-editor-wrap" bind:this={editorContainer} onmousedown={handleWrapperMousedown}></div>
            </div>

            <!-- Initial registers -->
            <div class="field">
                <label class="field-label">Initial registers</label>
                <datalist id="regs-list-dl">
                    {#each ALL_REGS as r}<option value={r}></option>{/each}
                </datalist>
                <div class="regs-list">
                    {#each regs as row, i}
                        <div class="reg-row">
                            <input
                                list="regs-list-dl"
                                class="input mono reg-name"
                                class:invalid={regInvalidIdxs.has(i)}
                                bind:value={row.reg}
                                placeholder="a0, sp, t0…"
                            />
                            <input class="input mono reg-val" bind:value={row.val} placeholder="0x0" />
                            <button class="remove-btn" onclick={() => removeReg(i)}>×</button>
                        </div>
                    {/each}
                    <button class="add-reg-btn" onclick={addReg}>+ Add register</button>
                </div>
            </div>

            {#if loadError}
                <div class="error-box">{loadError}</div>
            {/if}
        </div>

        <div class="panel-footer">
            <button class="btn btn-cancel" onclick={() => (ui.showEditor = false)}>Cancel</button>
            <button class="btn btn-load" onclick={load}>Load</button>
        </div>
    </div>
</div>

<style>
    .backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.4);
        z-index: 1000;
        display: flex;
        align-items: center;
        justify-content: center;
    }
    .panel {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 8px;
        width: 680px;
        max-width: 95vw;
        max-height: 90vh;
        display: flex;
        flex-direction: column;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
    }
    .panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 16px 12px;
        border-bottom: 1px solid var(--border);
        flex-shrink: 0;
    }
    .panel-title {
        font-family: var(--sans);
        font-size: 14px;
        font-weight: 600;
        color: var(--text);
    }
    .close-btn {
        background: none;
        border: none;
        cursor: pointer;
        font-size: 18px;
        line-height: 1;
        color: var(--text-dim);
        padding: 0 2px;
    }
    .close-btn:hover {
        color: var(--text);
    }
    .panel-body {
        padding: 16px;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 14px;
        flex: 1;
        min-height: 0;
    }
    .panel-footer {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        padding: 12px 16px;
        border-top: 1px solid var(--border);
        flex-shrink: 0;
    }
    .row2 {
        display: flex;
        gap: 10px;
    }
    .field {
        display: flex;
        flex-direction: column;
        gap: 5px;
        flex: 1;
    }
    .field-narrow {
        flex: 0 0 120px;
    }
    .field-label {
        font-family: var(--sans);
        font-size: 11px;
        font-weight: 600;
        color: var(--text-dim);
        text-transform: uppercase;
        letter-spacing: 0.05em;
    }
    .input {
        padding: 6px 8px;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--surface2);
        color: var(--text);
        font-family: var(--sans);
        font-size: 13px;
    }
    .input:focus {
        outline: none;
        border-color: var(--blue);
    }
    .mono {
        font-family: var(--mono);
    }
    .asm-editor-wrap {
        border: 1px solid var(--border);
        border-radius: 6px;
        overflow: hidden;
        transition: border-color 0.1s;
    }
    .asm-editor-wrap:has(:global(.cm-focused)) {
        border-color: var(--blue);
    }
    .asm-editor-wrap :global(.cm-editor) {
        min-height: 220px;
    }
    .regs-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
    }
    .reg-row {
        display: flex;
        gap: 6px;
        align-items: center;
    }
    .reg-name {
        flex: 0 0 80px;
    }
    .input.invalid {
        border-color: var(--red);
        background: var(--red-dim);
        color: var(--red);
    }
    .reg-val {
        flex: 1;
    }
    .remove-btn {
        background: none;
        border: none;
        cursor: pointer;
        font-size: 16px;
        color: var(--text-faint);
        padding: 0 4px;
        line-height: 1;
        flex-shrink: 0;
    }
    .remove-btn:hover {
        color: var(--red);
    }
    .add-reg-btn {
        align-self: flex-start;
        background: none;
        border: 1px dashed var(--border);
        border-radius: 6px;
        color: var(--text-dim);
        font-family: var(--sans);
        font-size: 12px;
        padding: 4px 10px;
        cursor: pointer;
    }
    .add-reg-btn:hover {
        border-color: var(--text-dim);
        color: var(--text);
    }
    .error-box {
        background: var(--red-dim);
        border: 1px solid var(--red);
        border-radius: 6px;
        color: var(--red);
        font-family: var(--mono);
        font-size: 12px;
        padding: 8px 12px;
        white-space: pre-wrap;
    }
    .btn {
        font-family: var(--sans);
        font-size: 13px;
        padding: 6px 16px;
        border-radius: 6px;
        border: 1px solid var(--border);
        cursor: pointer;
    }
    .btn-cancel {
        background: var(--surface2);
        color: var(--text-dim);
    }
    .btn-cancel:hover {
        color: var(--text);
        border-color: var(--text-faint);
    }
    .btn-load {
        background: var(--blue);
        color: #fff;
        border-color: var(--blue);
        font-weight: 600;
    }
    .btn-load:hover {
        opacity: 0.9;
    }
</style>
