/** Light, dark, or follow the OS. Stored so the choice survives a reload. */
export type Theme = "system" | "light" | "dark";

export const THEME_KEY = "fantasy-watch:theme";

export function loadTheme(): Theme {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    return raw === "light" || raw === "dark" ? raw : "system";
  } catch {
    return "system";
  }
}

/**
 * Stamps the choice on <html>. "system" removes the attribute so the
 * prefers-color-scheme block in the stylesheet takes over.
 */
export function applyTheme(theme: Theme) {
  const el = document.documentElement;
  if (theme === "system") delete el.dataset.theme;
  else el.dataset.theme = theme;
  try {
    if (theme === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* storage unavailable: the choice just won't persist */
  }
}

/** Does the OS ask for dark right now? False wherever matchMedia isn't available. */
export function prefersDark(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

/**
 * The theme actually on screen. Until someone picks one, "system" means the
 * toggle reflects the OS and flips away from whatever it's currently showing.
 */
export function resolveTheme(theme: Theme, osDark: boolean): "light" | "dark" {
  return theme === "system" ? (osDark ? "dark" : "light") : theme;
}
