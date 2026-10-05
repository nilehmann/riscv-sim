<script lang="ts">
    import type { Program } from "./types";
    import { PROGRAMS } from "./programs";
    import { sim, ui } from "./state.svelte";
    import { getIsa, ISA_IDS } from "./isa";
    import { _ } from "svelte-i18n";


    // Programs grouped by instruction set, then by folder, in registry order.
    // Programs without a folder are listed directly. The session's own
    // programs come first, in a folder of their own.
    const isaOf = (p: Program) => p.isa ?? "rv32";
    const USER = "\0user";
    const folderKey = (p: Program) =>
        sim.userPrograms.includes(p) ? `${isaOf(p)}:${USER}` : p.folder ? `${isaOf(p)}:${p.folder}` : null;
    const groups = $derived(ISA_IDS.map((id) => {
        const programs = PROGRAMS.filter((p) => isaOf(p) === id);
        const folders: { key: string; name: string; programs: Program[] }[] = [];
        const mine = sim.userPrograms.filter((p) => isaOf(p) === id);
        if (mine.length) folders.push({ key: `${id}:${USER}`, name: $_("controls.my_programs"), programs: mine });
        for (const p of programs) {
            const key = folderKey(p);
            if (!key) continue;
            let f = folders.find((f) => f.key === key);
            if (!f) folders.push((f = { key, name: p.folder!, programs: [] }));
            f.programs.push(p);
        }
        return { isa: getIsa(id), loose: programs.filter((p) => !p.folder), folders };
    }).filter((g) => g.loose.length > 0 || g.folders.length > 0));
    const allFolders = $derived(groups.flatMap((g) => g.folders));

    /** Folder whose programs are shown in the right column. */
    let activeFolder = $state<string | null>(null);
    const activePrograms = $derived(allFolders.find((f) => f.key === activeFolder)?.programs ?? []);

    function openEditor(blank: boolean) {
        ui.selectorOpen = false;
        ui.editorNew = blank;
        ui.showEditor = true;
    }

    // ── Menu aim ──
    // Moving diagonally from a category to its programs crosses other
    // categories. While the pointer heads toward the program column, switching
    // to the category under it is delayed; reaching the column cancels it.

    const AIM_DELAY = 300;
    /** Slack around the program column, so aiming at its corners still counts. */
    const AIM_SLACK = 20;
    let programColEl = $state<HTMLElement | null>(null);
    /** How far back a pointer position counts as "where it is coming from". */
    const AIM_WINDOW = 200;
    /** Recent pointer positions, oldest first. */
    let trail: { x: number; y: number; t: number }[] = [];
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;

    function cancelPending() {
        if (pendingTimer) clearTimeout(pendingTimer);
        pendingTimer = null;
    }

    function recordPointer(e: MouseEvent) {
        const last = trail[trail.length - 1];
        if (last && last.x === e.clientX && last.y === e.clientY) return;
        const t = performance.now();
        trail.push({ x: e.clientX, y: e.clientY, t });
        trail = trail.filter((p) => t - p.t <= AIM_WINDOW).slice(-4);
    }

    /** Whether the pointer is moving into the triangle spanned by the program column's left edge. */
    function aimingAtPrograms(): boolean {
        if (!programColEl || trail.length < 2) return false;
        const from = trail[0]!;
        const to = trail[trail.length - 1]!;
        const r = programColEl.getBoundingClientRect();
        if (to.x <= from.x || from.x >= r.left) return false;
        const slope = (x: number, y: number) => (y - from.y) / (x - from.x);
        const s = slope(to.x, to.y);
        return s >= slope(r.left, r.top - AIM_SLACK) && s <= slope(r.left, r.bottom + AIM_SLACK);
    }

    /** Shows `key`'s programs (null: none), now or once the pointer stops aiming at the column. */
    function hoverFolder(e: MouseEvent, key: string | null) {
        // mouseenter comes before the mousemove for the same position.
        recordPointer(e);
        cancelPending();
        if (key === activeFolder) return;
        if (!aimingAtPrograms()) {
            activeFolder = key;
            return;
        }
        pendingTimer = setTimeout(() => {
            pendingTimer = null;
            activeFolder = key;
        }, AIM_DELAY);
    }

    /** Pointer moving over a category while a switch waits: switch now if it stopped aiming. */
    function moveOverFolder(key: string | null) {
        if (pendingTimer && !aimingAtPrograms()) {
            cancelPending();
            activeFolder = key;
        }
    }

    function toggleSelector() {
        cancelPending();
        if (!ui.selectorOpen)
            activeFolder = (sim.program && folderKey(sim.program)) ?? allFolders[0]?.key ?? null;
        ui.selectorOpen = !ui.selectorOpen;
    }
    let barEl = $state<HTMLElement | null>(null);
    let scrubbing = $state(false);

    // Close dropdown when clicking outside
    $effect(() => {
        function handleOutsideClick(e: MouseEvent) {
            const target = e.target as Element;
            if (!target.closest(".custom-select")) {
                ui.selectorOpen = false;
            }
        }
        document.addEventListener("click", handleOutsideClick);
        return () => document.removeEventListener("click", handleOutsideClick);
    });

    function selectProgram(prog: Program) {
        cancelPending();
        ui.selectorOpen = false;
        sim.loadProgram(prog);
    }

    function scrubTo(e: PointerEvent) {
        if (!barEl) return;
        const rect = barEl.getBoundingClientRect();
        const ratio = Math.min(
            1,
            Math.max(0, (e.clientX - rect.left) / rect.width),
        );
        sim.scrubTo(ratio);
    }

    function onPointerDown(e: PointerEvent) {
        scrubbing = true;
        barEl?.setPointerCapture(e.pointerId);
        scrubTo(e);
    }

    function onPointerMove(e: PointerEvent) {
        if (!barEl?.hasPointerCapture(e.pointerId)) return;
        scrubTo(e);
    }

    function onPointerUp(e: PointerEvent) {
        barEl?.releasePointerCapture(e.pointerId);
        scrubbing = false;
    }

    // Tick indices (all steps except first and last)
    const tickIndices = $derived(
        sim.total > 2
            ? Array.from({ length: sim.total - 2 }, (_, i) => i + 1)
            : [],
    );
</script>

<div class="controls">
    <!-- Program selector -->
    <div class="custom-select">
        <button
            class="btn select-btn"
            onclick={(e) => {
                e.stopPropagation();
                toggleSelector();
            }}
        >
            <span>{sim.program?.name ?? ""}</span>
            <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
            >
                <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
        </button>
        <!-- Categories on the left; the active one's programs on the right. -->
        <div class="custom-select-list" class:open={ui.selectorOpen}>
            <!-- Capture: record the pointer before the items' handlers look at it. -->
            <ul class="folder-col" role="listbox" onmousemovecapture={recordPointer}>
                {#each groups as group}
                    {#if groups.length > 1}
                        <li class="group-title" role="presentation">{group.isa.shortName}</li>
                    {/if}
                    {#each group.loose as prog}
                        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                        <!-- svelte-ignore a11y_click_events_have_key_events -->
                        <li
                            role="option"
                            aria-selected={prog === sim.program}
                            class:current={prog === sim.program}
                            onclick={() => selectProgram(prog)}
                            onmouseenter={(e) => hoverFolder(e, null)}
                            onmousemove={() => moveOverFolder(null)}
                        >
                            {prog.name}
                        </li>
                    {/each}
                    {#each group.folders as folder}
                        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                        <!-- svelte-ignore a11y_click_events_have_key_events -->
                        <li
                            class="folder"
                            role="option"
                            aria-selected={folder.key === activeFolder}
                            class:active={folder.key === activeFolder}
                            onclick={() => {
                                cancelPending();
                                activeFolder = folder.key;
                            }}
                            onmouseenter={(e) => hoverFolder(e, folder.key)}
                            onmousemove={() => moveOverFolder(folder.key)}
                        >
                            <span>{folder.name}</span><span class="chevron" aria-hidden="true">›</span>
                        </li>
                    {/each}
                {/each}
            </ul>
            {#if activePrograms.length}
                <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                <ul
                    class="program-col"
                    role="listbox"
                    bind:this={programColEl}
                    onmouseenter={cancelPending}
                >
                    {#each activePrograms as prog}
                        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                        <!-- svelte-ignore a11y_click_events_have_key_events -->
                        <li
                            role="option"
                            aria-selected={prog === sim.program}
                            class:current={prog === sim.program}
                            onclick={() => selectProgram(prog)}
                        >
                            {prog.name}
                        </li>
                    {/each}
                </ul>
            {/if}
        </div>
    </div>

    <!-- Edit button -->
    <button class="btn edit-btn" onclick={() => openEditor(true)}>{$_('controls.new')}</button>
    <button class="btn edit-btn" onclick={() => openEditor(false)}>{$_('controls.edit')}</button>

    <!-- Step counter -->
    <span class="step-counter">{sim.posIdx + 1} / {sim.total}</span>

    <!-- Progress bar -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        class="progress-bar"
        bind:this={barEl}
        onpointerdown={onPointerDown}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
    >
        <div
            class="progress-fill"
            class:scrubbing
            style="width: {sim.progress}%"
        ></div>
        <div
            class="progress-thumb"
            class:scrubbing
            style="left: clamp(7px, {sim.progress}%, calc(100% - 7px))"
        ></div>
        {#each tickIndices as i}
            <div
                class="step-tick"
                style="left: {(i / (sim.total - 1)) * 100}%"
            ></div>
        {/each}
    </div>

    <!-- Navigation buttons -->
    <button class="btn nav-btn" disabled={sim.posIdx === 0} onclick={() => sim.go(-1)}>
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
        >
            <polyline points="15 18 9 12 15 6"></polyline>
        </svg>
        <span>{$_('controls.prev')}</span>
    </button>
    <button
        class="btn nav-btn"
        disabled={sim.posIdx === sim.total - 1}
        onclick={() => sim.go(1)}
    >
        <span>{$_('controls.next')}</span>
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
        >
            <polyline points="9 18 15 12 9 6"></polyline>
        </svg>
    </button>
</div>

<style>
    .controls {
        border-top: 1px solid var(--border);
        background: var(--surface);
        padding: 6px 16px;
        display: flex;
        align-items: center;
        gap: 12px;
    }
    .step-counter {
        font-family: var(--mono);
        font-size: 13px;
        color: var(--text-faint);
        min-width: 70px;
    }
    .progress-bar {
        flex: 1;
        height: 8px;
        background: var(--border);
        border-radius: 4px;
        cursor: pointer;
        position: relative;
    }
    .progress-fill {
        height: 100%;
        background: var(--blue);
        border-radius: 4px;
        transition: width 0.15s ease;
        pointer-events: none;
    }
    .progress-fill.scrubbing {
        transition: none;
    }
    .progress-thumb {
        position: absolute;
        top: 50%;
        width: 14px;
        height: 14px;
        background: var(--blue);
        border-radius: 50%;
        transform: translate(-50%, -50%);
        pointer-events: none;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
        transition: left 0.15s ease;
        z-index: 1;
    }
    .progress-thumb.scrubbing {
        transition: none;
    }
    .step-tick {
        position: absolute;
        top: 0;
        width: 1px;
        height: 100%;
        background: rgba(255, 255, 255, 0.45);
        pointer-events: none;
        transform: translateX(-50%);
    }
    .btn {
        font-family: var(--mono);
        font-size: 13px;
        padding: 6px 16px;
        border-radius: 6px;
        border: 1px solid var(--border);
        background: var(--surface2);
        color: var(--text);
        cursor: pointer;
        transition:
            background 0.15s,
            border-color 0.15s;
        white-space: nowrap;
    }
    .btn:hover:not(:disabled) {
        background: var(--surface);
        border-color: var(--text-dim);
    }
    .btn:disabled {
        opacity: 0.3;
        cursor: default;
    }
    .custom-select {
        position: relative;
    }
    .select-btn {
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .select-btn svg {
        flex-shrink: 0;
        opacity: 0.7;
    }
    .nav-btn {
        display: flex;
        align-items: center;
        gap: 6px;
    }
    .nav-btn svg {
        flex-shrink: 0;
        opacity: 0.7;
    }
    .custom-select-list {
        display: none;
        position: absolute;
        bottom: calc(100% + 4px);
        left: 0;
        background: var(--surface2);
        border: 1px solid var(--border);
        border-radius: 6px;
        z-index: 100;
        min-width: 100%;
        align-items: stretch;
    }
    .custom-select-list.open {
        display: flex;
    }
    .custom-select-list ul {
        list-style: none;
        padding: 4px 0;
        margin: 0;
    }
    .program-col {
        border-left: 1px solid var(--border);
        min-width: 220px;
    }
    .custom-select-list li {
        font-family: var(--mono);
        font-size: 13px;
        padding: 6px 16px;
        cursor: pointer;
        white-space: nowrap;
        color: var(--text);
    }
    .custom-select-list li:hover {
        background: var(--surface);
    }
    .custom-select-list li.current {
        color: var(--blue);
    }
    .custom-select-list li.folder {
        display: flex;
        justify-content: space-between;
        gap: 24px;
    }
    .custom-select-list li.folder.active {
        background: var(--surface);
    }
    .chevron {
        color: var(--text-faint);
    }
    .custom-select-list li.group-title {
        font-size: 11px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--text-faint);
        padding: 8px 16px 2px;
        cursor: default;
    }
    .custom-select-list li.group-title:hover {
        background: none;
    }
</style>
