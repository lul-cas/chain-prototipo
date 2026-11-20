export const THEMES = ['light', 'dark'] as const;

export type ThemeName = (typeof THEMES)[number];

export function applyTheme(theme: ThemeName): void {
  document.documentElement.setAttribute('data-theme', theme);
}
