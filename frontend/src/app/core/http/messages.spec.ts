import { messageFor } from './messages';

describe('messageFor (ADR-0010 D4)', () => {
  it('says a 412 version_mismatch without naming the item or blaming anyone (card #166)', () => {
    expect(messageFor('version_mismatch')).toBe('Este item mudou desde que você o abriu. Carregue a página de novo.');
  });

  it("takes a page's own text for a code, and the app's text for the others", () => {
    const page = { version_mismatch: 'O formulário mudou desde que você o abriu.' };

    expect(messageFor('version_mismatch', page)).toBe('O formulário mudou desde que você o abriu.');
    expect(messageFor('forbidden', page)).toBe('Você não tem permissão para fazer isso.');
  });

  it.each(['constructor', 'toString', 'hasOwnProperty', '__proto__'])(
    'treats %s, a name every object inherits, as a code without a text (card #188)',
    (code) => {
      const fallback = `Algo deu errado (código: ${code}). Tente de novo.`;

      expect(messageFor(code)).toBe(fallback);
      expect(messageFor(code, { version_mismatch: 'O formulário mudou desde que você o abriu.' })).toBe(fallback);
    },
  );
});
