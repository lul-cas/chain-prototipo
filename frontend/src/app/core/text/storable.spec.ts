import { storable } from './storable';

describe('storable', () => {
  it('refuses the NUL character and half of a UTF-16 pair (identity.md I1)', () => {
    for (const text of ['a\u0000b', '\u0000', 'a\ud800', '\ud800b', 'a\udc00b', '\udc00\ud800']) {
      expect(storable(text)).toBe(false);
    }
  });

  it('accepts whole pairs, controls other than NUL, and the empty text', () => {
    for (const text of ['', 'cpf', 'João', '🔑', 'a\u0001b\n\t', '🔑']) {
      expect(storable(text)).toBe(true);
    }
  });
});
