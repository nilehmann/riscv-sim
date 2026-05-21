<script lang="ts">
    import { ui } from "./state.svelte";
    import { locale, _ } from "svelte-i18n";

    const themes = [
        { value: "light",  key: "settings.theme_light"  },
        { value: "dark",   key: "settings.theme_dark"   },
        { value: "system", key: "settings.theme_system" },
    ] as const;

    const languages = [
        { value: "en", label: "English" },
        { value: "es", label: "Español" },
    ] as const;
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="backdrop" onclick={() => (ui.showSettings = false)}>
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="panel" onclick={(e) => e.stopPropagation()}>
        <div class="panel-header">
            <span class="panel-title">{$_('settings.title')}</span>
            <button class="close-btn" onclick={() => (ui.showSettings = false)}>×</button>
        </div>

        <div class="section">
            <div class="section-label">{$_('settings.theme_label')}</div>
            <div class="theme-options">
                {#each themes as t}
                    <button
                        class="theme-btn"
                        class:active={ui.theme === t.value}
                        onclick={() => (ui.theme = t.value)}
                    >{$_(t.key)}</button>
                {/each}
            </div>
        </div>

        <div class="section section-border">
            <div class="section-label">{$_('settings.editor_label')}</div>
            <div class="toggle-row">
                <span class="toggle-label">{$_('settings.vim_label')}</span>
                <button
                    class="toggle-btn"
                    class:active={ui.vimMode}
                    onclick={() => (ui.vimMode = !ui.vimMode)}
                >{ui.vimMode ? $_('settings.on') : $_('settings.off')}</button>
            </div>
        </div>

        <div class="section section-border">
            <div class="section-label">{$_('settings.language_label')}</div>
            <div class="theme-options">
                {#each languages as lang}
                    <button
                        class="theme-btn"
                        class:active={$locale === lang.value}
                        onclick={() => ($locale = lang.value)}
                    >{lang.label}</button>
                {/each}
            </div>
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
        width: 320px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
    }
    .panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 16px 12px;
        border-bottom: 1px solid var(--border);
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
    .section {
        padding: 16px;
    }
    .section-label {
        font-family: var(--sans);
        font-size: 12px;
        font-weight: 600;
        color: var(--text-dim);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-bottom: 8px;
    }
    .theme-options {
        display: flex;
        gap: 6px;
    }
    .theme-btn {
        flex: 1;
        padding: 6px 0;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--surface2);
        color: var(--text-dim);
        font-family: var(--sans);
        font-size: 13px;
        cursor: pointer;
    }
    .theme-btn:hover {
        color: var(--text);
        border-color: var(--text-faint);
    }
    .theme-btn.active {
        background: var(--blue-dim);
        border-color: var(--blue);
        color: var(--blue);
        font-weight: 600;
    }
    .section-border {
        border-top: 1px solid var(--border);
    }
    .toggle-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
    }
    .toggle-label {
        font-family: var(--sans);
        font-size: 13px;
        color: var(--text);
    }
    .toggle-btn {
        padding: 4px 14px;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--surface2);
        color: var(--text-dim);
        font-family: var(--sans);
        font-size: 13px;
        cursor: pointer;
        min-width: 48px;
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
</style>
