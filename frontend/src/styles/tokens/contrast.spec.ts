import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CONTRAST_PAIRS } from './contrast-pairs';
import { contrastRatio, readCustomProperties, resolveToken } from './contrast';

// Tests run from frontend/ (the Angular workspace root).
const tokensDir = resolve(process.cwd(), 'src/styles/tokens');
const read = (file: string) => readFileSync(join(tokensDir, file), 'utf8');

const primitives = readCustomProperties(read('primitives.css'));
const themes = {
  light: readCustomProperties(read('light.css')),
  dark: readCustomProperties(read('dark.css')),
};

describe('contrast helpers', () => {
  it('computes the WCAG reference ratios', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBe(1);
  });

  it('resolves var() chains and rejects unknown tokens', () => {
    const scope = new Map([
      ['--a', 'var(--b)'],
      ['--b', '#123456'],
      ['--c', 'var(--missing)'],
    ]);
    expect(resolveToken('--a', scope)).toBe('#123456');
    expect(() => resolveToken('--c', scope)).toThrow(/--missing/);
  });
});

describe.each(Object.entries(themes))('%s theme tokens', (theme, semantic) => {
  it('defines at least one token', () => {
    expect(semantic.size).toBeGreaterThan(0);
  });

  it.each(CONTRAST_PAIRS.map((p) => [p.fg, p.bg, p.min, p.use] as const))(
    '%s on %s reaches %s:1 (%s)',
    (fg, bg, min) => {
      const ratio = contrastRatio(resolveToken(fg, semantic, primitives), resolveToken(bg, semantic, primitives));
      expect(ratio, `${theme}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(min);
    },
  );

  it('defines every color as a reference to a primitive, never as a literal', () => {
    const literals = [...semantic].filter(([name, value]) => name.startsWith('--color-') && !value.startsWith('var(--chain-'));
    // Translucent overlays are the only allowed exception; they are never drawn under text.
    expect(literals.filter(([name]) => name !== '--color-bg-backdrop')).toEqual([]);
  });
});

describe('theme parity', () => {
  it('light and dark define exactly the same semantic tokens', () => {
    expect([...themes.dark.keys()].sort()).toEqual([...themes.light.keys()].sort());
  });
});

describe('component styles', () => {
  const appDir = resolve(process.cwd(), 'src/app');
  const cssFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return cssFiles(path);
      return path.endsWith('.css') ? [path] : [];
    });

  it('use tokens only: no literal colors in component stylesheets', () => {
    const offenders = cssFiles(appDir).flatMap((file) => {
      const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      const hits = css.match(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(/g) ?? [];
      return hits.map((hit) => `${file.slice(appDir.length + 1)}: ${hit}`);
    });
    expect(offenders).toEqual([]);
  });

  it('reads only semantic or component tokens, never primitives', () => {
    const offenders = cssFiles(appDir).filter((file) => /var\(--chain-color-/.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('uses tokens for lengths: no literal px, rem, em or ms outside media queries', () => {
    const offenders = cssFiles(appDir).flatMap((file) => {
      const css = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/@media\b[^{]*/g, '@media ');
      const hits = css.match(/(?<![\w-])\d*\.?\d+(?:px|rem|em|ms)\b/g) ?? [];
      return hits.map((hit) => `${file.slice(appDir.length + 1)}: ${hit}`);
    });
    expect(offenders).toEqual([]);
  });
});
