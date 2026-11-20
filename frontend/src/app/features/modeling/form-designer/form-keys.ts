const MAX_KEY = 64;

/**
 * A new field's key from its label (form-designer.md §8.2, FD4): accents removed, lowercase, every run of other characters as
 * one `_`, no `_` at either end, at most 64 characters. A key that would not start with a letter starts with `campo_`, and an
 * empty one is `campo`, so the key always passes FM001.
 */
export function keyFromLabel(label: string): string {
  const key = trimUnderscores(
    label
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_'),
  );
  if (key === '') {
    return 'campo';
  }
  return /^[a-z]/.test(key) ? cut(key, MAX_KEY) : cut(`campo_${key}`, MAX_KEY);
}

/** The key, or the key with `_2`, `_3`… when it is already used at the same level (FM002), still within 64 characters. */
export function uniqueKey(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) {
    return base;
  }
  for (let n = 2; ; n++) {
    const suffix = `_${n}`;
    const key = cut(base, MAX_KEY - suffix.length) + suffix;
    if (!taken.has(key)) {
      return key;
    }
  }
}

function cut(key: string, length: number): string {
  return trimUnderscores(key.slice(0, length));
}

function trimUnderscores(key: string): string {
  return key.replace(/^_+|_+$/g, '');
}
