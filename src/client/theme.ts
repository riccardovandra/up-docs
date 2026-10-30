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

const DARK = `color-scheme:dark;${declarations(T3_CODE_DARK_THEME_COLORS)}`;

// Light has no specificity and everything else is screen only, so the print
// stylesheet's light colours win on paper.
const BASE_CSS =
  `:where(:root){color-scheme:light;${declarations(T3_CODE_LIGHT_THEME_COLORS)}}` +
  `@media screen{` +
  `@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${DARK}}}` +
  `:root[data-theme="dark"]{${DARK}}` +
  `}`;

let paletteStyle: HTMLStyleElement | null = null;

/** Follows T3 Code's appearance, and its palette when one came with it. */
export function applyTheme(theme: EmbedThemeMessage): void {
  document.documentElement.dataset.theme = theme.appearance;
  paletteStyle ??= document.head.appendChild(document.createElement("style"));
  // html:root outranks the base rules whatever the appearance selector.
  paletteStyle.textContent = theme.colors
    ? `@media screen{html:root{${declarations(theme.colors)}}}`
    : "";
}

declare global {
  interface Window {
    /** Set by the T3 Code mobile app before the page loads. */
    t3DocsTheme?: unknown;
  }
}

/**
 * Installs T3 Code's light and dark palettes, following the system until T3
 * Code says otherwise. Framed, the embed bridge passes on the parent's theme
 * message. The mobile app loads this page top-level, so it sets
 * `window.t3DocsTheme` before load and posts later changes from the page itself.
 */
export function startTheme(): void {
  const base = document.createElement("style");
  base.textContent = BASE_CSS;
  document.head.appendChild(base);

  const initial = parseThemeMessage(window.t3DocsTheme);
  if (initial) applyTheme(initial);
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) return;
    const theme = parseThemeMessage(event.data);
    if (theme) applyTheme(theme);
  });
}
