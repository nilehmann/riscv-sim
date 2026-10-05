<script lang="ts">
    import { tick, untrack } from "svelte";
    import { EditorView, basicSetup } from "codemirror";
    import { Compartment } from "@codemirror/state";
    import type { Extension } from "@codemirror/state";
    import { StreamLanguage, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
    import { tags } from "@lezer/highlight";
    import { oneDark } from "@codemirror/theme-one-dark";
    import { vim } from "@replit/codemirror-vim";
    import type { Program, MemoryRegion } from "./types";
    import type { Isa, IsaId } from "./isa/types";
    import { getIsa, ISA_IDS } from "./isa";
    import { parseTypes } from "./ctypes";
    import { regionDecl } from "./regions";
    import {
        regionShape, formKey, formFromRegion, initFromForm, parseValue, setArrayLen, removeRow,
    } from "./regionForm";
    import type { FormValues } from "./regionForm";
    import { sim, ui } from "./state.svelte";
    import { AppError } from "./types";
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

    // ── C mode for struct definitions ─────────────────────────────────────────

    const C_KEYWORDS = new Set(["struct", "typedef", "union", "enum"]);
    const C_TYPES = new Set(["char", "short", "int", "long", "signed", "unsigned", "void"]);
    const cLang = StreamLanguage.define<{ inComment: boolean }>({
        startState: () => ({ inComment: false }),
        token(stream, state) {
            if (state.inComment) {
                if (stream.skipTo("*/")) { stream.match("*/"); state.inComment = false; }
                else stream.skipToEnd();
                return "comment";
            }
            if (stream.eatSpace()) return null;
            if (stream.match("//")) { stream.skipToEnd(); return "comment"; }
            if (stream.match("/*")) { state.inComment = true; return "comment"; }
            if (stream.match(/^0x[0-9a-fA-F]+/i) || stream.match(/^\d+/)) return "number";
            if (stream.match(/^[A-Za-z_]\w*/)) {
                const word = stream.current();
                if (C_KEYWORDS.has(word)) return "keyword";
                if (C_TYPES.has(word)) return "builtin";
                return "variable";
            }
            stream.next();
            return null;
        },
    });

    const asmHighlight = HighlightStyle.define([
        { tag: tags.lineComment,                 color: "var(--text-faint)", fontStyle: "italic" },
        { tag: tags.blockComment,                color: "var(--text-faint)", fontStyle: "italic" },
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
    let typesViewRef: EditorView | null = null;
    const views = () => [viewRef, typesViewRef].filter((v): v is EditorView => v !== null);

    function syncTheme() {
        for (const v of views())
            v.dispatch({ effects: themeCompartment.reconfigure(isDark() ? oneDark : []) });
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

    let types = $state(sim.program?.types ?? "");
    const typesEnv = $derived(parseTypes(types, isa.wordBytes));

    // Legacy regions show up converted to their C declaration.
    type RegionRow = { addr: string; decl: string; values: FormValues };
    let scrollEls: (HTMLElement | null)[] = [];
    let regions = $state<RegionRow[]>(
        sim.regions.map((r, ri) => ({
            addr: hex(r.addr),
            decl: regionDecl(sim.program!.memoryRegions![ri]!, ri).decl,
            values: formFromRegion(r),
        }))
    );
    /** Each region's parsed declaration, or its error. */
    const shapes = $derived(
        regions.map((r) =>
            typesEnv instanceof AppError ? null : regionShape(r.decl, typesEnv, isa.wordBytes),
        ),
    );

    let loadError = $state<string | null>(null);
    let editorContainer = $state<HTMLElement | null>(null);
    let typesContainer = $state<HTMLElement | null>(null);

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

    function makeView(parent: HTMLElement, doc: string, lang: Extension, onChange: (doc: string) => void) {
        return new EditorView({
            doc,
            extensions: [
                basicSetup,
                lang,
                syntaxHighlighting(asmHighlight),
                structuralTheme,
                themeCompartment.of(isDark() ? oneDark : []),
                vimCompartment.of(untrack(() => ui.vimMode) ? vim() : []),
                EditorView.updateListener.of((update) => {
                    if (update.docChanged) onChange(update.state.doc.toString());
                }),
            ],
            parent,
        });
    }

    $effect(() => {
        if (!editorContainer) return;
        const v = makeView(
            editorContainer,
            untrack(() => assembly),
            langCompartment.of(untrack(() => makeLang(isa))),
            (doc) => (assembly = doc),
        );
        viewRef = v;
        darkMQ.addEventListener("change", syncTheme);
        return () => {
            darkMQ.removeEventListener("change", syncTheme);
            viewRef = null;
            v.destroy();
        };
    });

    $effect(() => {
        if (!typesContainer) return;
        const v = makeView(typesContainer, untrack(() => types), cLang, (doc) => (types = doc));
        typesViewRef = v;
        return () => {
            typesViewRef = null;
            v.destroy();
        };
    });

    $effect(() => {
        ui.theme; // track theme changes from settings
        syncTheme();
    });

    $effect(() => {
        ui.vimMode; // track vim mode changes from settings
        for (const v of views())
            v.dispatch({ effects: vimCompartment.reconfigure(ui.vimMode ? vim() : []) });
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
        const taken = new Set(shapes.map((s) => (s && !(s instanceof AppError) ? s.name : null)));
        let n = regions.length;
        while (taken.has(`arr${n}`)) n++;
        regions = [...regions, { addr: "0x10000", decl: `int arr${n}[1]`, values: {} }];
    }
    function removeRegion(i: number) {
        regions = regions.filter((_, idx) => idx !== i);
    }
    /** Adding or removing an element rewrites the `[N]` in the declaration. */
    async function addElement(ri: number, len: number) {
        regions[ri]!.decl = setArrayLen(regions[ri]!.decl, len + 1);
        await tick();
        scrollEls[ri]?.scrollTo({ top: scrollEls[ri]!.scrollHeight });
    }
    function removeElement(ri: number, row: number, len: number) {
        const r = regions[ri]!;
        r.values = removeRow(r.values, row);
        r.decl = setArrayLen(r.decl, len - 1);
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
        if (typesEnv instanceof AppError) {
            loadError = get(_)("editor.err_types", { values: { msg: typesEnv.message } });
            return;
        }
        const memoryRegions: MemoryRegion[] = [];
        for (let ri = 0; ri < regions.length; ri++) {
            const r = regions[ri]!;
            const addr = parseInt(r.addr);
            if (isNaN(addr)) { loadError = get(_)("editor.err_region_address", { values: { n: ri + 1 } }); return; }
            const shape = shapes[ri]!;
            if (shape instanceof AppError) {
                loadError = get(_)("editor.err_region_decl", { values: { n: ri + 1, msg: shape.message } });
                return;
            }
            const init = initFromForm(shape, r.values, typesEnv, isa.wordBytes);
            if (init instanceof AppError) {
                loadError = get(_)("editor.err_region_value", { values: { n: ri + 1, msg: init.message } });
                return;
            }
            memoryRegions.push({ addr, decl: r.decl.trim(), init });
        }
        const prog: Program = {
            name, isa: isa.id, entryPoint: entryPoint.trim() || undefined, baseAddress: parsedBase,
            initialRegs, assembly, showStack, stackBase: parsedStackBase, returnAddress: parsedReturnAddr,
            types: types.trim() ? types : undefined, memoryRegions,
        };
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
                        {@const shape = shapes[ri]}
                        <div class="region-card">
                            <div class="region-header">
                                <input class="input mono region-addr" bind:value={region.addr} placeholder="0x10000" />
                                <input
                                    class="input mono region-decl"
                                    class:invalid={shape instanceof AppError}
                                    bind:value={region.decl}
                                    placeholder={$_('editor.placeholder_decl')}
                                />
                                <button class="remove-btn" onclick={() => removeRegion(ri)}>×</button>
                            </div>
                            {#if shape instanceof AppError}
                                <div class="field-error">{shape.message}</div>
                            {:else if shape}
                                {@const rows = shape.len ?? 1}
                                {@const named = shape.columns.some((c) => c !== "")}
                                <div class="elements-scroll" bind:this={scrollEls[ri]}>
                                    <div
                                        class="values-grid"
                                        style="grid-template-columns: auto repeat({shape.columns.length}, minmax(6rem, 1fr)) auto"
                                    >
                                        {#if named}
                                            <span></span>
                                            {#each shape.columns as col}
                                                <span class="col-head mono">{col}</span>
                                            {/each}
                                            <span></span>
                                        {/if}
                                        {#each { length: rows } as _row, row}
                                            <span class="elem-idx mono">{shape.len === null ? "" : `[${row}]`}</span>
                                            {#each shape.columns as col}
                                                {@const key = formKey(shape, row, col)}
                                                <input
                                                    class="input mono elem-val"
                                                    class:invalid={parseValue(region.values[key] ?? "") === null}
                                                    value={region.values[key] ?? ""}
                                                    oninput={(e) => (region.values[key] = e.currentTarget.value)}
                                                    placeholder="0"
                                                />
                                            {/each}
                                            {#if shape.len !== null && shape.len > 1}
                                                <button class="remove-btn" onclick={() => removeElement(ri, row, shape.len!)}>×</button>
                                            {:else}
                                                <span></span>
                                            {/if}
                                        {/each}
                                    </div>
                                </div>
                                {#if shape.len !== null}
                                    <button class="add-reg-btn" onclick={() => addElement(ri, shape.len!)}>{$_('editor.add_element')}</button>
                                {/if}
                            {/if}
                        </div>
                    {/each}
                    <button class="add-reg-btn" onclick={addRegion}>{$_('editor.add_region')}</button>
                </div>
            </div>

            <!-- Struct definitions used by the regions -->
            <div class="field">
                <label class="field-label">{$_('editor.types')}</label>
                <div class="asm-editor-wrap types-editor-wrap" bind:this={typesContainer}></div>
                {#if typesEnv instanceof AppError}
                    <div class="field-error">{typesEnv.message}</div>
                {/if}
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
    .types-editor-wrap :global(.cm-editor) {
        min-height: 120px;
    }
    .field-error {
        color: var(--red);
        font-family: var(--mono);
        font-size: 14px;
        white-space: pre-wrap;
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
    .region-decl {
        flex: 2;
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
        max-height: 14rem;
        overflow: auto;
    }
    .values-grid {
        display: grid;
        gap: 5px 8px;
        align-items: center;
    }
    .col-head {
        font-size: 13px;
        color: var(--blue);
        white-space: nowrap;
    }
    .elem-idx {
        flex: 0 0 3rem;
        font-size: 14px;
        color: var(--text-faint);
        text-align: right;
    }
    .elem-val {
        min-width: 0;
    }
</style>
