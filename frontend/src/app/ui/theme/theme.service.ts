import { DOCUMENT, Injectable, computed, inject, signal } from '@angular/core';

export type ThemePreference = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

/** localStorage key; also read by the pre-paint script in src/index.html. */
export const THEME_STORAGE_KEY = 'chain.theme';

const isPreference = (value: unknown): value is ThemePreference =>
  value === 'system' || value === 'light' || value === 'dark';

/**
 * Owns the theme (design-system.md §3.5): the user's preference, stored per browser, and the
 * resolved theme written to `<html data-theme>`, where the semantic tokens are switched.
 * "system" follows `prefers-color-scheme` and reacts to changes of the OS setting.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly document = inject(DOCUMENT);
  private readonly media = this.document.defaultView?.matchMedia?.('(prefers-color-scheme: dark)') ?? null;
  private readonly systemTheme = signal<Theme>(this.media?.matches ? 'dark' : 'light');

  readonly preference = signal<ThemePreference>(this.readStoredPreference());
  readonly theme = computed<Theme>(() => {
    const preference = this.preference();
    return preference === 'system' ? this.systemTheme() : preference;
  });

  constructor() {
    this.media?.addEventListener('change', (event) => {
      this.systemTheme.set(event.matches ? 'dark' : 'light');
      this.apply();
    });
    this.apply();
  }

  setPreference(preference: ThemePreference): void {
    this.preference.set(preference);
    try {
      this.document.defaultView?.localStorage.setItem(THEME_STORAGE_KEY, preference);
    } catch {
      // Storage can be unavailable (private mode, blocked site data); the choice then lasts for this page only.
    }
    this.apply();
  }

  private apply(): void {
    this.document.documentElement.setAttribute('data-theme', this.theme());
  }

  private readStoredPreference(): ThemePreference {
    try {
      const stored = this.document.defaultView?.localStorage.getItem(THEME_STORAGE_KEY);
      return isPreference(stored) ? stored : 'system';
    } catch {
      return 'system';
    }
  }
}
