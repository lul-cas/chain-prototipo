import { invalidNameText } from './process-name';

describe('invalidNameText (workflow-editor.md §10.1, card #172)', () => {
  it('says the limit when the name sent was over 100 characters', () => {
    expect(invalidNameText('a'.repeat(101))).toBe('O nome pode ter no máximo 100 caracteres.');
  });

  it('says the characters when the name sent was within the limit', () => {
    expect(invalidNameText('a'.repeat(100))).toBe('O nome tem caracteres que não podem ser guardados.');
    expect(invalidNameText('Crédito\u0000Rural')).toBe('O nome tem caracteres que não podem ser guardados.');
  });
});
