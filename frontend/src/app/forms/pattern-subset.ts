/** The first construct of a pattern the allowlist refuses, and what to write instead when something does the same. */
export interface RefusedConstruct {
  readonly construct: string;
  readonly replacement: string | null;
}

const REPLACEMENTS: Readonly<Record<string, string>> = {
  d: '[0-9]',
  D: '[^0-9]',
  w: '[a-zA-Z0-9_]',
  W: '[^a-zA-Z0-9_]',
  s: '[ \\t\\n\\r]',
  S: '[^ \\t\\n\\r]',
  A: '^',
  z: '$',
  Z: '$',
  e: '\\x1B',
  f: '\\x0C',
  v: '\\x0B',
  '0': '\\x00',
};
const ALNUM = /^[A-Za-z0-9]$/;
const HEX = /^[0-9A-Fa-f]+$/;
const DIGIT = /^[0-9]$/;

/**
 * The pattern allowlist of forms.md F1 (FM005; owner decision on card #149): only constructs that .NET and JavaScript read
 * alike. The server's `PatternSubset` runs the same scan over the same vectors (`pattern-subset.json`). Null when every
 * construct is allowed; a pattern this accepts may still not compile, which is checked apart.
 */
export function firstRefused(pattern: string): RefusedConstruct | null {
  const lookaheads: boolean[] = []; // for each open group, whether it is a lookahead
  let repeatable = false; // whether a quantifier may follow
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    switch (c) {
      case '\\': {
        const escape = escapeAt(pattern, i);
        if (escape.refused) {
          return escape.refused;
        }
        i += escape.length;
        repeatable = true;
        break;
      }
      case '[': {
        const read = classAt(pattern, i);
        if (read.refused) {
          return read.refused;
        }
        i = read.end;
        repeatable = true;
        break;
      }
      case '(':
        if (pattern[i + 1] === '?') {
          const kind = pattern[i + 2] ?? '';
          if (kind !== ':' && kind !== '=' && kind !== '!') {
            const lookbehind = kind === '<' && (pattern[i + 3] === '=' || pattern[i + 3] === '!');
            return { construct: pattern.slice(i, i + (lookbehind ? 4 : 3)), replacement: null };
          }
          lookaheads.push(kind === '=' || kind === '!');
          i += 3;
        } else {
          lookaheads.push(false);
          i++;
        }
        repeatable = false;
        break;
      case ')':
        // A lone ) is left to the compile check, which refuses it.
        repeatable = !(lookaheads.length > 0 && lookaheads.pop());
        i++;
        break;
      case '|':
      case '^':
      case '$':
        repeatable = false;
        i++;
        break;
      case '.':
        return { construct: '.', replacement: '[^\\n]' };
      case '*':
      case '+':
      case '?':
        if (!repeatable) {
          return { construct: c, replacement: null };
        }
        i = lazy(pattern, i + 1);
        repeatable = false;
        break;
      case '{': {
        const end = quantifierEnd(pattern, i);
        if (end === null || !repeatable) {
          return { construct: '{', replacement: '\\{' };
        }
        i = lazy(pattern, end);
        repeatable = false;
        break;
      }
      case ']':
      case '}':
        return { construct: c, replacement: `\\${c}` };
      default:
        repeatable = true;
        i++;
    }
  }
  return null;
}

/** The escape at `i`: its length, or why it is refused. */
function escapeAt(pattern: string, i: number): { length: number; refused?: RefusedConstruct } {
  if (i + 1 >= pattern.length) {
    return { length: 1 }; // a trailing \ doesn't compile, which the compile check refuses
  }
  const next = pattern[i + 1];
  if (next === 't' || next === 'n' || next === 'r') {
    return { length: 2 };
  }
  if (next === 'x') {
    return HEX.test(pattern.slice(i + 2, i + 4)) && i + 4 <= pattern.length ? { length: 4 } : { length: 2, refused: { construct: '\\x', replacement: null } };
  }
  if (next === 'u') {
    return HEX.test(pattern.slice(i + 2, i + 6)) && i + 6 <= pattern.length ? { length: 6 } : { length: 2, refused: { construct: '\\u', replacement: null } };
  }
  if (next >= '!' && next <= '~' && !ALNUM.test(next)) {
    return { length: 2 }; // escaped punctuation
  }
  const replacement = Object.hasOwn(REPLACEMENTS, next) ? REPLACEMENTS[next] : !ALNUM.test(next) ? next : null;
  return { length: 2, refused: { construct: `\\${next}`, replacement } };
}

/** The class at `i`: why it is refused, or the index after its `]`. */
function classAt(pattern: string, i: number): { end: number; refused?: RefusedConstruct } {
  let j = i + 1;
  if (pattern[j] === '^') {
    j++;
  }
  if (pattern[j] === ']') {
    return { end: j, refused: { construct: pattern.slice(i, j + 1), replacement: null } };
  }
  while (j < pattern.length && pattern[j] !== ']') {
    if (pattern[j] === '\\') {
      const escape = escapeAt(pattern, j);
      if (escape.refused) {
        return { end: j, refused: escape.refused };
      }
      j += escape.length;
    } else if (pattern[j] === '[') {
      return { end: j, refused: { construct: '[', replacement: '\\[' } };
    } else {
      j++;
    }
  }
  return { end: j + 1 }; // an unclosed class doesn't compile, which the compile check refuses
}

/** The index after a quantifier `{n}`, `{n,}` or `{n,m}` at `i`; null when there is none. */
function quantifierEnd(pattern: string, i: number): number | null {
  let j = i + 1;
  const digits = (from: number) => {
    let k = from;
    while (k < pattern.length && DIGIT.test(pattern[k])) {
      k++;
    }
    return k - from;
  };
  const first = digits(j);
  if (first === 0) {
    return null;
  }
  j += first;
  if (pattern[j] === ',') {
    j++;
    j += digits(j);
  }
  return pattern[j] === '}' ? j + 1 : null;
}

/** After a quantifier, the lazy `?` when there is one. */
function lazy(pattern: string, i: number): number {
  return pattern[i] === '?' ? i + 1 : i;
}
