<script lang="ts">
    import type { Program } from "./types";
    import { PROGRAMS } from "./programs";
    import { sim, ui } from "./state.svelte";

    let selectedProgram = $state<Program>(PROGRAMS[0]!);
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
        selectedProgram = prog;
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
                ui.selectorOpen = !ui.selectorOpen;
            }}
        >
            <span>{selectedProgram.name}</span>
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
        <ul
            class="custom-select-list"
            class:open={ui.selectorOpen}
            role="listbox"
        >
            {#each PROGRAMS as prog}
                <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <li
                    role="option"
                    aria-selected={false}
                    onclick={() => selectProgram(prog)}
                >
                    {prog.name}
                </li>
            {/each}
        </ul>
    </div>

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
    <button class="btn" disabled={sim.posIdx === 0} onclick={() => sim.go(-1)}
        >← Anterior</button
    >
    <button
        class="btn"
        disabled={sim.posIdx === sim.total - 1}
        onclick={() => sim.go(1)}>Siguiente →</button
    >
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
    .custom-select-list {
        display: none;
        position: absolute;
        bottom: calc(100% + 4px);
        left: 0;
        background: var(--surface2);
        border: 1px solid var(--border);
        border-radius: 6px;
        list-style: none;
        padding: 4px 0;
        margin: 0;
        z-index: 100;
        min-width: 100%;
    }
    .custom-select-list.open {
        display: block;
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
</style>
