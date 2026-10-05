<script lang="ts">
    import { tick, untrack } from "svelte";
    import { EditorView, basicSetup } from "codemirror";
    import { Compartment } from "@codemirror/state";
    import { StreamLanguage, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
    import { tags } from "@lezer/highlight";
    import { oneDark } from "@codemirror/theme-one-dark";
    import { vim } from "@replit/codemirror-vim";
    import type { Program, MemoryRegion } from "./types";
    import type { Isa, IsaId } from "./isa/types";
    import { getIsa, ISA_IDS } from "./isa";
    import { fitsInt, leavesOf } from "./ctypes";
    import { sim, ui } from "./state.svelte";
    import { get } from "svelte/store";
    import { _ } from "svelte-i18n";

    // ── Assembly language mode (keywords come from the program's ISA) ─────────

    let isaId = $state<IsaId>(sim.isa.id);
    const isa = $derived(getIsa(isaId));
    const isReg = (r: string) => isa.regs.names.includes(r);
    const ALL_REGS = $derived(isa.regs.names);
    const SP = $derived(isa.regs.sp);
    const ZERO = $derived(isa.regs.zero);
    const RA = $derived(isa.regs.returnAddr);

    const makeLang = (isa: Isa) => {
      const REGISTERS = new Set<string>([...isa.regs.names, ...Object.keys(isa.regs.aliases)]);
      const MNEMONICS = isa.editor.mnemonics;
      return StreamLanguage.define({
        token(stream) {
            if (stream.eatSpace()) return null;
            if (stream.match(/^#.*/) || stream.match(/^\/\/.*/)) return "comment";
            if (stream.match(/^-?0x[0-9a-fA-F]+/i) || stream.match(/^-?\d+/)) return "number";
            if (stream.match(/^[a-zA-Z_.][a-zA-Z0-9_.]*/)) {
                const word = stream.current();
                if (stream.peek() === ":") return "def";
                if (word.startsWith(".")) return "meta";
                const lower = word.toLowerCase();
                if (REGISTERS.has(lower)) return "builtin";
                if (MNEMONICS.has(lower)) return "keyword";
                return "variable";
            }
            stream.next();
            return null;
        },
      });
    };

    const asmHighlight = HighlightStyle.define([
        { tag: tags.lineComment,                 color: "var(--text-faint)", fontStyle: "italic" },
        { tag: tags.number,                      color: "var(--blue)" },
        { tag: tags.keyword,                     color: "var(--purple)" },
        { tag: tags.standard(tags.variableName), color: "var(--orange)" },
        { tag: tags.definition(tags.labelName),  color: "var(--green)", fontWeight: "600" },
        { tag: tags.variableName,                color: "var(--text-dim)" },
        { tag: tags.meta,                        color: "var(--text-faint)" },
    ]);

    const structuralTheme = EditorView.theme({
        "&": { fontSize: "20px" },
        "&.cm-focused": { outline: "none" },
        ".cm-content": { fontFamily: "var(--mono)", caretColor: "var(--text)" },
        ".cm-gutters": { fontFamily: "var(--mono)" },
        ".cm-scroller": { lineHeight: "1.6" },
        ".cm-activeLine": { background: "rgba(128,128,128,0.05)" },
        ".cm-activeLineGutter": { background: "rgba(128,128,128,0.05)" },
    });

    const langCompartment = new Compartment();
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

    const hex = (v: number) => "0x" + v.toString(16);
    /** Default return-address register value for ISAs that have one. */
    const DEFAULT_RA = 0x8050;

    let name = $state(sim.program?.name ?? "");
    let entryPoint = $state(sim.program?.entryPoint ?? "");
    let baseAddress = $state(hex(sim.program?.baseAddress ?? sim.isa.defaults.baseAddress));
    let assembly = $state(sim.program?.assembly ?? "");
    let regs = $state<Array<{ reg: string; val: string }>>(
        Object.entries(
            (() => {
                const ir = sim.program?.initialRegs;
                const raDefault: Record<string, number> = RA ? { [RA]: DEFAULT_RA } : {};
                const defaults: Record<string, number> = { [SP]: isa.defaults.sp, ...raDefault };
                if (!ir) return sim.program?.showStack ? raDefault : defaults;
                return sim.program.showStack
                    ? Object.fromEntries(Object.entries(ir).filter(([k]) => k !== SP))
                    : ir;
            })()
        ).map(([reg, val]) => ({ reg, val: "0x" + (val as number).toString(16) }))
    );
    let showStack = $state(sim.program?.showStack ?? false);
    let stackBase = $state(hex(sim.program?.stackBase ?? sim.isa.defaults.stackBase));
    let stackSp   = $state(hex(sim.program?.initialRegs?.[sim.isa.regs.sp] ?? sim.isa.defaults.sp));
    // Only for ISAs that keep the return address on the stack.
    let returnAddr = $state(sim.program?.returnAddress != null ? hex(sim.program.returnAddress) : "");

    // Registers and addresses differ between ISAs, so switching starts from
    // the new ISA's defaults. The assembly text is kept.
    function setIsa(id: IsaId) {
        if (id === isaId) return;
        isaId = id;
        const next = getIsa(id);
        const ra = next.regs.returnAddr;
        regs = [
            ...(showStack ? [] : [{ reg: next.regs.sp, val: hex(next.defaults.sp) }]),
            ...(ra ? [{ reg: ra, val: hex(DEFAULT_RA) }] : []),
        ];
        baseAddress = hex(next.defaults.baseAddress);
        stackBase = hex(next.defaults.stackBase);
        stackSp = hex(next.defaults.sp);
        returnAddr = "";
        viewRef?.dispatch({ effects: langCompartment.reconfigure(makeLang(next)) });
    }

    type RegionRow = { addr: string; elementSize: 1 | 2 | 4; elements: string[] };
    let scrollEls: (HTMLElement | null)[] = [];
    let regions = $state<RegionRow[]>(
        sim.regions.map(r => {
            const leaves = leavesOf(r.root).filter(l => !l.pad);
            return {
                addr: "0x" + r.addr.toString(16),
                elementSize: (leaves[0]?.size ?? 4) as 1 | 2 | 4,
                elements: leaves.map(l => "0x" + l.value!.toString(16)),
            };
        })
    );

    let loadError = $state<string | null>(null);
    let editorContainer = $state<HTMLElement | null>(null);

    const regInvalidIdxs = $derived.by(() => {
        const seen = new Map<string, number>();
        const errors = new Set<number>();
        for (let i = 0; i < regs.length; i++) {
            const reg = regs[i]!.reg.trim();
            if (!isReg(reg) || reg === ZERO || (showStack && reg === SP)) {
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
                langCompartment.of(untrack(() => makeLang(isa))),
                syntaxHighlighting(asmHighlight),
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
        const forbidden = new Set([ZERO, ...(showStack ? [SP] : [])]);
        const next = ALL_REGS.find((r) => !used.has(r) && !forbidden.has(r)) ?? ALL_REGS[0]!;
        regs = [...regs, { reg: next, val: "0x0" }];
    }

    function removeReg(i: number) {
        regs = regs.filter((_, idx) => idx !== i);
    }

    function addRegion() {
        regions = [...regions, { addr: "0x10000", elementSize: 4, elements: ["0x0"] }];
    }
    function removeRegion(i: number) {
        regions = regions.filter((_, idx) => idx !== i);
    }
    async function addElement(ri: number) {
        regions[ri]!.elements = [...regions[ri]!.elements, "0x0"];
        await tick();
        scrollEls[ri]?.scrollTo({ top: scrollEls[ri]!.scrollHeight });
    }
    function removeElement(ri: number, ei: number) {
        regions[ri]!.elements = regions[ri]!.elements.filter((_, idx) => idx !== ei);
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
            loadError = get(_)("editor.err_fix_regs");
            return;
        }
        const parsedBase = parseInt(baseAddress);
        if (isNaN(parsedBase)) {
            loadError = get(_)("editor.err_base_address");
            return;
        }
        const initialRegs: Record<string, number> = {};
        for (const { reg, val } of regs) {
            const v = parseInt(val);
            if (isNaN(v)) {
                loadError = get(_)("editor.err_reg_value", { values: { reg } });
                return;
            }
            initialRegs[reg] = v;
        }
        let parsedStackBase: number | undefined;
        if (showStack) {
            parsedStackBase = parseInt(stackBase);
            if (isNaN(parsedStackBase)) { loadError = get(_)("editor.err_stack_base"); return; }
            const parsedStackSp = parseInt(stackSp);
            if (isNaN(parsedStackSp)) { loadError = get(_)("editor.err_stack_pointer"); return; }
            initialRegs[SP] = parsedStackSp;
        }
        let parsedReturnAddr: number | undefined;
        if (RA === null && returnAddr.trim()) {
            parsedReturnAddr = parseInt(returnAddr);
            if (isNaN(parsedReturnAddr)) { loadError = get(_)("editor.err_return_address"); return; }
        }
        const memoryRegions: MemoryRegion[] = [];
        for (let ri = 0; ri < regions.length; ri++) {
            const r = regions[ri]!;
            const addr = parseInt(r.addr);
            if (isNaN(addr)) { loadError = get(_)("editor.err_region_address", { values: { n: ri + 1 } }); return; }
            const elements: number[] = [];
            for (let ei = 0; ei < r.elements.length; ei++) {
                const v = parseInt(r.elements[ei]!);
                if (isNaN(v)) { loadError = get(_)("editor.err_region_element", { values: { n: ri + 1, ei } }); return; }
                const err = fitsInt(v, r.elementSize) ? null : { message: `Region ${ri + 1}, element ${ei}: ${v} does not fit in ${r.elementSize} byte(s)` };
                if (err) { loadError = err.message; return; }
                elements.push(v);
            }
            memoryRegions.push({ addr, elementSize: r.elementSize, elements });
        }
        const prog: Program = { name, isa: isa.id, entryPoint: entryPoint.trim() || undefined, baseAddress: parsedBase, initialRegs, assembly, showStack, stackBase: parsedStackBase, returnAddress: parsedReturnAddr, memoryRegions };
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
            <span class="panel-title">{$_('editor.title')}</span>
            <button class="close-btn" onclick={() => (ui.showEditor = false)}>×</button>
        </div>

        <div class="panel-body">
            <!-- Architecture -->
            <div class="toggle-row">
                <span class="toggle-label">{$_('editor.isa')}</span>
                <div class="size-group">
                    {#each ISA_IDS as id}
                        <button
                            class="size-btn"
                            class:active={isaId === id}
                            onclick={() => setIsa(id)}
                        >{getIsa(id).shortName}</button>
                    {/each}
                </div>
            </div>

            <!-- Name + entry point + base address row -->
            <div class="row2">
                <div class="field">
                    <label class="field-label">{$_('editor.name')}</label>
                    <input class="input" bind:value={name} placeholder={$_('editor.placeholder_name')} />
                </div>
                <div class="field">
                    <label class="field-label">{$_('editor.entry_point')}</label>
                    <input class="input mono" bind:value={entryPoint} placeholder={$_('editor.placeholder_entry')} />
                </div>
                <div class="field field-narrow">
                    <label class="field-label">{$_('editor.base_address')}</label>
                    <input class="input mono" bind:value={baseAddress} placeholder={hex(isa.defaults.baseAddress)} />
                </div>
            </div>

            <!-- Assembly editor -->
            <div class="field">
                <label class="field-label">{$_('editor.assembly')}</label>
                <div class="asm-editor-wrap" bind:this={editorContainer} onmousedown={handleWrapperMousedown}></div>
            </div>

            <!-- Initial registers -->
            <div class="field">
                <label class="field-label">{$_('editor.initial_registers')}</label>
                <datalist id="regs-list-dl">
                    {#each ALL_REGS.filter(r => r !== ZERO && !(showStack && r === SP)) as r}<option value={r}></option>{/each}
                </datalist>
                <div class="regs-list">
                    {#each regs as row, i}
                        <div class="reg-row">
                            <input
                                list="regs-list-dl"
                                class="input mono reg-name"
                                class:invalid={regInvalidIdxs.has(i)}
                                bind:value={row.reg}
                                placeholder={ALL_REGS.slice(0, 3).join(", ") + "…"}
                            />
                            <input class="input mono reg-val" bind:value={row.val} placeholder={$_('editor.placeholder_val')} />
                            <button class="remove-btn" onclick={() => removeReg(i)}>×</button>
                        </div>
                    {/each}
                    <button class="add-reg-btn" onclick={addReg}>{$_('editor.add_register')}</button>
                </div>
            </div>

            <!-- Return address: on the stack for ISAs without a link register -->
            {#if RA === null}
                <div class="field">
                    <label class="field-label">{$_('editor.return_address')}</label>
                    <input class="input mono" bind:value={returnAddr} placeholder={$_('editor.placeholder_return')} />
                </div>
            {/if}

            <div class="toggle-row">
                <span class="toggle-label">{$_('editor.show_stack')}</span>
                <button
                    class="toggle-btn"
                    class:active={showStack}
                    onclick={() => (showStack = !showStack)}
                >{showStack ? $_('settings.on') : $_('settings.off')}</button>
            </div>

            {#if showStack}
                <div class="row2">
                    <div class="field">
                        <label class="field-label">{$_('editor.stack_base')}</label>
                        <input class="input mono" bind:value={stackBase} placeholder={hex(isa.defaults.stackBase)} />
                    </div>
                    <div class="field">
                        <label class="field-label">{$_('editor.stack_pointer', { values: { sp: SP } })}</label>
                        <input class="input mono" bind:value={stackSp} placeholder={hex(isa.defaults.sp)} />
                    </div>
                </div>
            {/if}

            <!-- Memory regions -->
            <div class="field">
                <label class="field-label">{$_('editor.memory_regions')}</label>
                <div class="regions-list">
                    {#each regions as region, ri}
                        <div class="region-card">
                            <div class="region-header">
                                <input class="input mono region-addr" bind:value={region.addr} placeholder="0x10000" />
                                <div class="size-group">
                                    {#each [1, 2, 4] as sz}
                                        <button
                                            class="size-btn"
                                            class:active={region.elementSize === sz}
                                            onclick={() => (region.elementSize = sz as 1|2|4)}
                                        >{sz}B</button>
                                    {/each}
                                </div>
                                <button class="remove-btn" onclick={() => removeRegion(ri)}>×</button>
                            </div>
                            <div class="elements-scroll" bind:this={scrollEls[ri]}>
                                {#each region.elements as _elem, ei}
                                    <div class="elem-row">
                                        <span class="elem-idx mono">[{ei}]</span>
                                        <input class="input mono elem-val" bind:value={region.elements[ei]} placeholder={$_('editor.placeholder_val')} />
                                        <button class="remove-btn" onclick={() => removeElement(ri, ei)}>×</button>
                                    </div>
                                {/each}
                            </div>
                            <button class="add-reg-btn" onclick={() => addElement(ri)}>{$_('editor.add_element')}</button>
                        </div>
                    {/each}
                    <button class="add-reg-btn" onclick={addRegion}>{$_('editor.add_region')}</button>
                </div>
            </div>

            {#if loadError}
                <div class="error-box">{loadError}</div>
            {/if}
        </div>

        <div class="panel-footer">
            <button class="btn btn-cancel" onclick={() => (ui.showEditor = false)}>{$_('editor.cancel')}</button>
            <button class="btn btn-load" onclick={load}>{$_('editor.load')}</button>
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
        width: 920px;
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
        padding: 18px 20px 16px;
        border-bottom: 1px solid var(--border);
        flex-shrink: 0;
    }
    .panel-title {
        font-family: var(--sans);
        font-size: 19px;
        font-weight: 600;
        color: var(--text);
    }
    .close-btn {
        background: none;
        border: none;
        cursor: pointer;
        font-size: 24px;
        line-height: 1;
        color: var(--text-dim);
        padding: 0 2px;
    }
    .close-btn:hover {
        color: var(--text);
    }
    .panel-body {
        padding: 20px;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 18px;
        flex: 1;
        min-height: 0;
    }
    .panel-footer {
        display: flex;
        justify-content: flex-end;
        gap: 10px;
        padding: 16px 20px;
        border-top: 1px solid var(--border);
        flex-shrink: 0;
    }
    .row2 {
        display: flex;
        gap: 12px;
    }
    .field {
        display: flex;
        flex-direction: column;
        gap: 6px;
        flex: 1;
    }
    .field-narrow {
        flex: 0 0 160px;
    }
    .field-label {
        font-family: var(--sans);
        font-size: 14px;
        font-weight: 600;
        color: var(--text-dim);
        text-transform: uppercase;
        letter-spacing: 0.05em;
    }
    .input {
        padding: 8px 10px;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--surface2);
        color: var(--text);
        font-family: var(--sans);
        font-size: 16px;
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
        min-height: 300px;
    }
    .regs-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }
    .reg-row {
        display: flex;
        gap: 8px;
        align-items: center;
    }
    .reg-name {
        flex: 0 0 100px;
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
        font-size: 20px;
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
        font-size: 15px;
        padding: 5px 12px;
        cursor: pointer;
    }
    .add-reg-btn:hover {
        border-color: var(--text-dim);
        color: var(--text);
    }
    .toggle-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
    }
    .toggle-label {
        font-family: var(--sans);
        font-size: 16px;
        color: var(--text);
    }
    .toggle-btn {
        padding: 6px 18px;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--surface2);
        color: var(--text-dim);
        font-family: var(--sans);
        font-size: 16px;
        cursor: pointer;
        min-width: 58px;
    }
    .toggle-btn:hover {
        border-color: var(--text-faint);
        color: var(--text);
    }
    .toggle-btn.active {
        background: var(--blue-dim);
        border-color: var(--blue);
        color: var(--blue);
        font-weight: 600;
    }
    .error-box {
        background: var(--red-dim);
        border: 1px solid var(--red);
        border-radius: 6px;
        color: var(--red);
        font-family: var(--mono);
        font-size: 15px;
        padding: 10px 14px;
        white-space: pre-wrap;
    }
    .btn {
        font-family: var(--sans);
        font-size: 16px;
        padding: 8px 20px;
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
    .regions-list {
        display: flex;
        flex-direction: column;
        gap: 10px;
    }
    .region-card {
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 10px 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;
    }
    .region-header {
        display: flex;
        gap: 8px;
        align-items: center;
    }
    .region-addr {
        flex: 1;
    }
    .size-group {
        display: flex;
        gap: 3px;
    }
    .size-btn {
        padding: 5px 10px;
        border: 1px solid var(--border);
        border-radius: 4px;
        background: var(--surface);
        color: var(--text-dim);
        font-family: var(--mono);
        font-size: 14px;
        cursor: pointer;
    }
    .size-btn.active {
        background: var(--blue-dim);
        border-color: var(--blue);
        color: var(--blue);
        font-weight: 600;
    }
    .elements-scroll {
        max-height: 12rem;
        overflow-y: auto;
        direction: rtl;
        display: flex;
        flex-direction: column;
        gap: 5px;
    }
    .elem-row {
        direction: ltr;
        display: flex;
        gap: 8px;
        align-items: center;
    }
    .elem-idx {
        flex: 0 0 3rem;
        font-size: 14px;
        color: var(--text-faint);
        text-align: right;
    }
    .elem-val {
        flex: 1;
    }
</style>
