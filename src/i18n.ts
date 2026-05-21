import { addMessages, init, getLocaleFromNavigator } from "svelte-i18n";
import en from "./locales/en.json";
import es from "./locales/es.json";

addMessages("en", en);
addMessages("es", es);

const STORAGE_KEY = "locale";

function resolveInitialLocale(): "en" | "es" {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "en" || stored === "es") return stored;
    const nav = getLocaleFromNavigator();
    if (nav?.startsWith("en")) return "en";
    return "es";
}

export function setupI18n() {
    init({ fallbackLocale: "es", initialLocale: resolveInitialLocale() });
}

export function persistLocale(locale: string) {
    if (locale === "en" || locale === "es") localStorage.setItem(STORAGE_KEY, locale);
}
