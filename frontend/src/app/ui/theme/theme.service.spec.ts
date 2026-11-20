import { TestBed } from '@angular/core/testing';
import { THEME_STORAGE_KEY, ThemeService } from './theme.service';

type Listener = (event: { matches: boolean }) => void;

function fakeSystemScheme(dark: boolean) {
  const listeners: Listener[] = [];
  const query = {
    matches: dark,
    addEventListener: (_: string, listener: Listener) => listeners.push(listener),
  };
  // jsdom has no matchMedia, so the test defines it.
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockReturnValue(query as unknown as MediaQueryList),
  });
  return {
    change(toDark: boolean) {
      query.matches = toDark;
      listeners.forEach((l) => l({ matches: toDark }));
    },
  };
}

describe('ThemeService', () => {
  const html = document.documentElement;

  beforeEach(() => {
    localStorage.clear();
    html.removeAttribute('data-theme');
  });

  afterEach(() => vi.restoreAllMocks());

  it('follows the operating system when nothing is stored', () => {
    fakeSystemScheme(true);
    const service = TestBed.inject(ThemeService);
    expect(service.preference()).toBe('system');
    expect(service.theme()).toBe('dark');
    expect(html.getAttribute('data-theme')).toBe('dark');
  });

  it('reacts when the operating system setting changes while on "system"', () => {
    const system = fakeSystemScheme(false);
    TestBed.inject(ThemeService);
    expect(html.getAttribute('data-theme')).toBe('light');
    system.change(true);
    expect(html.getAttribute('data-theme')).toBe('dark');
  });

  it('applies and stores an explicit choice, which overrides the system', () => {
    const system = fakeSystemScheme(true);
    const service = TestBed.inject(ThemeService);
    service.setPreference('light');
    expect(html.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    system.change(true);
    expect(html.getAttribute('data-theme')).toBe('light');
  });

  it('restores the stored choice', () => {
    fakeSystemScheme(false);
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    const service = TestBed.inject(ThemeService);
    expect(service.preference()).toBe('dark');
    expect(html.getAttribute('data-theme')).toBe('dark');
  });

  it('ignores an unknown stored value', () => {
    fakeSystemScheme(false);
    localStorage.setItem(THEME_STORAGE_KEY, 'purple');
    expect(TestBed.inject(ThemeService).preference()).toBe('system');
  });

  it('still switches when storage is unavailable', () => {
    fakeSystemScheme(false);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const service = TestBed.inject(ThemeService);
    service.setPreference('dark');
    expect(html.getAttribute('data-theme')).toBe('dark');
  });
});
