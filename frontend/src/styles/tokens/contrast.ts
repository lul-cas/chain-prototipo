/**
 * Pure helpers for the design-token checks in contrast.spec.ts: reading custom properties
 * out of a token stylesheet, resolving var() chains, and the WCAG 2.x contrast ratio.
 */

/** Custom property declarations (`--name: value;`) found in a stylesheet, in order. */
export function readCustomProperties(css: string): Map<string, string> {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const result = new Map<string, string>();
  for (const match of withoutComments.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    result.set(match[1], match[2].trim());
  }
  return result;
}

/** Follows `var(--x)` references until a literal value is reached. */
export function resolveToken(name: string, ...scopes: Map<string, string>[]): string {
  const seen = new Set<string>();
  let current = name;
  for (;;) {
    if (seen.has(current)) {
      throw new Error(`Circular token reference at ${current}`);
    }
    seen.add(current);
    const value = scopes.find((s) => s.has(current))?.get(current);
    if (value === undefined) {
      throw new Error(`Token ${current} is not defined (while resolving ${name})`);
    }
    const reference = /^var\((--[\w-]+)\)$/.exec(value);
    if (!reference) {
      return value;
    }
    current = reference[1];
  }
}

function channel(hex: string, offset: number): number {
  const v = parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance of an opaque `#RRGGBB` color. */
export function relativeLuminance(hex: string): number {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) {
    throw new Error(`Expected an opaque #RRGGBB color, got "${hex}"`);
  }
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

/** WCAG 2.x contrast ratio, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
