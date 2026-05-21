<script lang="ts">
    import CodePanel from "./CodePanel.svelte";
    import StackVisualization from "./StackVisualization.svelte";
    import MemoryVisualization from "./MemoryVisualization.svelte";
    import RegisterPanel from "./RegisterPanel.svelte";
    import Controls from "./Controls.svelte";
    import Settings from "./Settings.svelte";
    import ProgramEditor from "./ProgramEditor.svelte";
    import { sim, ui } from "./state.svelte";
    import { setupI18n, persistLocale } from "./i18n";
    import { locale, _ } from "svelte-i18n";

    setupI18n();

    const darkMQ = window.matchMedia('(prefers-color-scheme: dark)');

    $effect(() => {
        localStorage.setItem('vimMode', String(ui.vimMode));
    });

    $effect(() => {
        const l = $locale;
        if (!l) return;
        persistLocale(l);
        document.documentElement.lang = l;
    });

    $effect(() => {
        localStorage.setItem('theme', ui.theme);
        const apply = () => {
            const effective =
                ui.theme === 'system' ? (darkMQ.matches ? 'dark' : 'light') : ui.theme;
            document.documentElement.dataset.theme = effective;
        };
        apply();
        darkMQ.addEventListener('change', apply);
        return () => darkMQ.removeEventListener('change', apply);
    });

    let tooltipEl = $state<HTMLElement | null>(null);
    let tooltipText = $state("");
    let tooltipVisible = $state(false);
    let tooltipX = $state(0);
    let tooltipY = $state(0);

    function onMouseOver(e: MouseEvent) {
        const el = (e.target as Element | null)?.closest(
            "[data-tooltip]",
        ) as HTMLElement | null;
        if (!el) {
            tooltipVisible = false;
            return;
        }
        tooltipText = el.dataset["tooltip"] ?? "";
        tooltipVisible = true;

        const targetEl = (e.target as Element | null)?.closest(
            "[data-target-addr]",
        ) as HTMLElement | null;
        if (targetEl) {
            const addr = parseInt(targetEl.dataset["targetAddr"]!);
            document
                .getElementById(`al-${addr.toString(16)}`)
                ?.classList.add("target-hl");
        }
    }

    function onMouseOut(e: MouseEvent) {
        if (!(e.target as Element | null)?.closest("[data-tooltip]")) return;
        tooltipVisible = false;
        document
            .querySelectorAll(".target-hl")
            .forEach((el) => el.classList.remove("target-hl"));
    }

    function onMouseMove(e: MouseEvent) {
        if (!tooltipVisible || !tooltipEl) return;
        const gap = 12;
        let x = e.clientX + gap;
        let y = e.clientY + gap;
        if (x + tooltipEl.offsetWidth > window.innerWidth)
            x = e.clientX - tooltipEl.offsetWidth - gap;
        if (y + tooltipEl.offsetHeight > window.innerHeight)
            y = e.clientY - tooltipEl.offsetHeight - gap;
        tooltipX = x;
        tooltipY = y;
    }
</script>

<svelte:document
    onmouseover={onMouseOver}
    onmouseout={onMouseOut}
    onmousemove={onMouseMove}
/>

<!-- Tooltip (global, single instance) -->
<div
    class="tooltip"
    bind:this={tooltipEl}
    style="display:{tooltipVisible
        ? 'block'
        : 'none'}; left:{tooltipX}px; top:{tooltipY}px"
>
    {tooltipText}
</div>

<!-- App layout -->
<header class="app-header">
    <span class="app-title">RISC-V Simulator</span>
    <button class="settings-btn" onclick={() => (ui.showSettings = true)} data-tooltip={$_('settings.tooltip')}>⚙</button>
</header>

{#if ui.showSettings}
    <Settings />
{/if}

{#if ui.showEditor}
    <ProgramEditor />
{/if}

<div class="main">
    <CodePanel />
    <div class="center-panel">
        <MemoryVisualization />
        {#if sim.stackEnabled}
            <StackVisualization />
        {/if}
    </div>
    <RegisterPanel />
</div>

<Controls />

<style>
    /* ── Global resets & body ── */
    :global(*) {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
    }
    :global(body) {
        background: var(--bg);
        color: var(--text);
        font-family: var(--sans);
        height: 100vh;
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }
    /* ── App shell ── */
    .app-header {
        background: var(--surface);
        border-bottom: 1px solid var(--border);
        padding: 10px 20px;
        flex-shrink: 0;
        display: flex;
        align-items: center;
    }
    .app-title {
        font-family: var(--sans);
        font-size: 14px;
        font-weight: 600;
        color: var(--text-dim);
        letter-spacing: 0.03em;
        flex: 1;
    }
    .settings-btn {
        background: none;
        border: none;
        cursor: pointer;
        font-size: 16px;
        color: var(--text-faint);
        padding: 0 2px;
        line-height: 1;
    }
    .settings-btn:hover {
        color: var(--text-dim);
    }
    .main {
        flex: 1;
        display: grid;
        grid-template-columns: 360px 1fr 220px;
        grid-template-rows: 1fr;
        gap: 0;
        overflow: hidden;
        min-height: 0;
    }
    .center-panel {
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }
    /* ── Tooltip ── */
    .tooltip {
        position: fixed;
        background: var(--text);
        color: var(--bg);
        padding: 4px 10px;
        border-radius: 4px;
        font-size: 12px;
        white-space: pre;
        z-index: 9999;
        pointer-events: none;
        font-weight: normal;
        font-family: var(--mono);
    }
    /* ── Global CSS custom properties ── */
    :global(:root) {
        --bg: #ffffff;
        --surface: #f6f8fa;
        --surface2: #eaeef2;
        --border: #d0d7de;
        --text: #1f2328;
        --text-dim: #656d76;
        --text-faint: #9198a1;
        --green: #1a7f37;
        --green-dim: rgba(26, 127, 55, 0.1);
        --blue: #0969da;
        --blue-dim: rgba(9, 105, 218, 0.1);
        --orange: #9a6700;
        --orange-dim: rgba(154, 103, 0, 0.12);
        --red: #cf222e;
        --red-dim: rgba(207, 34, 46, 0.1);
        --purple: #8250df;
        --purple-dim: rgba(130, 80, 223, 0.1);
        --mono: "IBM Plex Mono", monospace;
        --sans: "IBM Plex Sans", sans-serif;
    }
    :global([data-theme="dark"]) {
        --bg: #0d1117;
        --surface: #161b22;
        --surface2: #21262d;
        --border: #30363d;
        --text: #e6edf3;
        --text-dim: #8b949e;
        --text-faint: #6e7681;
        --green: #3fb950;
        --green-dim: rgba(63, 185, 80, 0.1);
        --blue: #58a6ff;
        --blue-dim: rgba(88, 166, 255, 0.1);
        --orange: #d29922;
        --orange-dim: rgba(210, 153, 34, 0.12);
        --red: #f85149;
        --red-dim: rgba(248, 81, 73, 0.1);
        --purple: #bc8cff;
        --purple-dim: rgba(188, 140, 255, 0.1);
    }
    :global([data-tooltip]) {
        cursor: default;
    }
</style>
