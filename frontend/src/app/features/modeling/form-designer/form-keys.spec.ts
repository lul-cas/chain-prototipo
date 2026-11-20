import { keyFromLabel, uniqueKey } from './form-keys';

describe('keys from labels (form-designer.md §8.2, FD4)', () => {
  it.each([
    ['Valor solicitado', 'valor_solicitado'],
    ['Área de texto', 'area_de_texto'],
    ['  CPF / CNPJ do tomador  ', 'cpf_cnpj_do_tomador'],
    ['E-mail', 'e_mail'],
    ['já_existe__duas', 'ja_existe_duas'],
    ['Ação!', 'acao'],
  ])('%s gives %s', (label, key) => {
    expect(keyFromLabel(label)).toBe(key);
  });

  it('starts with campo_ when the key would not start with a letter, and is campo when nothing is left', () => {
    expect(keyFromLabel('1º trimestre')).toBe('campo_1_trimestre');
    expect(keyFromLabel('2026')).toBe('campo_2026');
    expect(keyFromLabel('   ')).toBe('campo');
    expect(keyFromLabel('***')).toBe('campo');
  });

  it('has at most 64 characters, and no _ at its end after cutting', () => {
    const long = keyFromLabel('a'.repeat(63) + ' b c');
    expect(long).toBe('a'.repeat(63));
    expect(keyFromLabel('palavra '.repeat(20)).length).toBeLessThanOrEqual(64);
    expect(keyFromLabel('palavra '.repeat(20)).endsWith('_')).toBe(false);
    expect(keyFromLabel('9'.repeat(70))).toMatch(/^campo_9+$/);
    expect(keyFromLabel('9'.repeat(70)).length).toBe(64);
  });

  it('passes FM001 for any label', () => {
    for (const label of ['', 'Ação', '1', '_x_', 'ÇÃO', '🙂 sorriso', 'a'.repeat(200)]) {
      expect(keyFromLabel(label)).toMatch(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/);
    }
  });
});

describe('unique keys at a level (FM002)', () => {
  it('adds _2, _3 and so on to a key in use', () => {
    expect(uniqueKey('valor', new Set())).toBe('valor');
    expect(uniqueKey('valor', new Set(['valor']))).toBe('valor_2');
    expect(uniqueKey('valor', new Set(['valor', 'valor_2']))).toBe('valor_3');
  });

  it('cuts the base so the suffix fits in 64 characters', () => {
    const base = 'a'.repeat(64);
    expect(uniqueKey(base, new Set([base]))).toBe('a'.repeat(62) + '_2');
  });
});
