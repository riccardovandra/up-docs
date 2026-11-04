import {
  T3_CODE_DARK_THEME_COLORS,
  T3_CODE_LIGHT_THEME_COLORS,
  type ThemeColorRole,
} from "../host/themePalettes.ts";

import {
  parseThemeMessage,
  type EmbedThemeColors,
  type EmbedThemeMessage,
} from "../shared/embed.ts";

/**
 * Each colour variable in styles.css and the T3 Code colour role it takes, so
 * the defaults and a custom T3 theme reach the same names. styles.css
 * documents what each variable is for.
 */
const THEME_VARIABLES = {
  "--bg": "canvas",
  "--surface": "surface",
  "--popover": "surfaceOverlay",
  "--sidebar": "sidebar",
  "--text": "text",
  "--muted": "mutedForeground",
  "--text-subtle": "placeholder",
  "--border": "border",
  "--input": "input",
  "--ring": "focus",
  "--accent": "messageAction",
  "--accent-text": "messageActionForeground",
  "--hover": "accentSurface",
  "--chip-bg": "accentSurface",
  "--chip-text": "accentSurfaceForeground",
  "--code-bg": "accentSurface",
  "--danger": "errorForeground",
  "--danger-surface": "errorSurface",
} as const satisfies Record<string, ThemeColorRole>;

function declarations(colors: EmbedThemeColors): string {
  return Object.entries(THEME_VARIABLES)
    .flatMap(([variable, role]) => (colors[role] ? [`${variable}:${colors[role]};`] : []))
    .join("");
}

/**
 * UP Content's dark palette: neutral greys, off-white text and white primary
 * actions with near-black ink. It replaces T3 Code's dark defaults; a palette
 * T3 Code sends when it embeds this app still wins.
 */
const UP_CONTENT_DARK_THEME_COLORS: EmbedThemeColors = {
  ...T3_CODE_DARK_THEME_COLORS,
  canvas: "#161616",
  surface: "#1e1e1e",
  surfaceOverlay: "#212121",
  sidebar: "#1e1e1e",
  text: "#f2f2f2",
  mutedForeground: "#b4b4b4",
  placeholder: "#808080",
  border: "#2e2e2e",
  input: "#3a3a3a",
  focus: "#b4b4b4",
  messageAction: "#ffffff",
  messageActionForeground: "#111111",
  accentSurface: "#2a2a2a",
  accentSurfaceForeground: "#f2f2f2",
  errorForeground: "#f04438",
  errorSurface: "#2c1715",
};

// A white accent would turn the home page's tinted covers light grey.
const DARK = `color-scheme:dark;--tint:#4a4a4a;${declarations(UP_CONTENT_DARK_THEME_COLORS)}`;

// Light has no specificity and everything else is screen only, so the print
// stylesheet's light colours win on paper.
const BASE_CSS =
  `:where(:root){color-scheme:light;${declarations(T3_CODE_LIGHT_THEME_COLORS)}}` +
  `@media screen{` +
  `@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${DARK}}}` +
  `:root[data-theme="dark"]{${DARK}}` +
  `}`;

export type Appearance = "system" | "light" | "dark";

const APPEARANCE_KEY = "up-docs:appearance";

/** The standalone site's saved appearance; "system" when none is saved or storage is blocked. */
export function storedAppearance(): Appearance {
  try {
    const value = localStorage.getItem(APPEARANCE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function showAppearance(appearance: Appearance): void {
  if (appearance === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = appearance;
}

/** Saves and applies the standalone site's appearance. T3 Code sets its own when it embeds this app. */
export function setAppearance(appearance: Appearance): void {
  try {
    if (appearance === "system") localStorage.removeItem(APPEARANCE_KEY);
    else localStorage.setItem(APPEARANCE_KEY, appearance);
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
  showAppearance(appearance);
}

let paletteStyle: HTMLStyleElement | null = null;

/** Follows T3 Code's appearance, and its palette when one came with it. */
export function applyTheme(theme: EmbedThemeMessage): void {
  document.documentElement.dataset.theme = theme.appearance;
  paletteStyle ??= document.head.appendChild(document.createElement("style"));
  // html:root outranks the base rules whatever the appearance selector.
  paletteStyle.textContent = theme.colors
    ? `@media screen{html:root{--tint:var(--accent);${declarations(theme.colors)}}}`
    : "";
}

declare global {
  interface Window {
    /** Set by the T3 Code mobile app before the page loads. */
    t3DocsTheme?: unknown;
  }
}

/**
 * Installs the light and dark palettes, following the saved appearance (or
 * the system) until T3 Code says otherwise. Framed, the embed bridge passes on the parent's theme
 * message. The mobile app loads this page top-level, so it sets
 * `window.t3DocsTheme` before load and posts later changes from the page itself.
 */
export function startTheme(options: { readonly embedded: boolean }): void {
  const base = document.createElement("style");
  base.textContent = BASE_CSS;
  document.head.appendChild(base);
  if (!options.embedded) showAppearance(storedAppearance());

  const initial = parseThemeMessage(window.t3DocsTheme);
  if (initial) applyTheme(initial);
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) return;
    const theme = parseThemeMessage(event.data);
    if (theme) applyTheme(theme);
  });
}
