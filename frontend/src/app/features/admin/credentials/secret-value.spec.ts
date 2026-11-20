import { MAX_VALUE_BYTES, valueProblem, valueWarnings } from './secret-value';

describe("a credential's value (automation-ui.md §4.2, §4.7)", () => {
  it('warns about spaces at the edges, and characters a header cannot carry, without blocking', () => {
    expect(valueWarnings('chn_abc')).toEqual([]);
    expect(valueWarnings(' chave ')).toEqual(['O valor começa ou termina com espaço. Ele será enviado assim.']);
    expect(valueWarnings('senha\tcom tab')).toEqual([]);
    expect(valueWarnings('ação')).toEqual([
      'Este valor tem caracteres que um cabeçalho HTTP não aceita, como acentos ou quebras de linha. Ele só funciona na autenticação básica.',
    ]);
    expect(valueWarnings('linha\nnova')).toHaveLength(1);
  });

  it('requires a value of at most 8 192 bytes in UTF-8, of text that can be stored', () => {
    expect(valueProblem('')).toBe('Informe o valor.');
    expect(valueProblem('a'.repeat(MAX_VALUE_BYTES))).toBeNull();
    expect(valueProblem('ã'.repeat(4097))).toBe('O valor pode ter no máximo 8.192 bytes.'); // 2 bytes each
    expect(valueProblem('nul\u0000')).toBe('O valor tem caracteres que não podem ser guardados.');
  });
});
