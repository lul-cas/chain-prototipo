import { typeLabel } from './type-labels';

describe('type labels (workflow-editor.md §10.7, expression-language.md §2)', () => {
  it.each([
    ['text', 'texto'],
    ['number', 'número'],
    ['boolean', 'sim ou não'],
    ['date', 'data'],
    ['datetime', 'data e hora'],
    ['time', 'hora'],
    ['object', 'objeto'],
    ['file', 'arquivo'],
    ['unknown', 'tipo desconhecido'],
  ])('names %s as %s', (type, label) => {
    expect(typeLabel(type)).toBe(label);
  });

  // Card #213: a list is "lista de" and its element in the plural.
  it.each([
    ['list<text>', 'lista de textos'],
    ['list<number>', 'lista de números'],
    ['list<boolean>', 'lista de valores sim ou não'],
    ['list<date>', 'lista de datas'],
    ['list<datetime>', 'lista de datas e horas'],
    ['list<time>', 'lista de horas'],
    ['list<object>', 'lista de objetos'],
    ['list<file>', 'lista de arquivos'],
    ['list<unknown>', 'lista de valores de tipo desconhecido'],
    ['list<list<file>>', 'lista de listas de arquivos'],
    ['list<list<list<text>>>', 'lista de listas de listas de textos'],
  ])('names %s as %s', (type, label) => {
    expect(typeLabel(type)).toBe(label);
  });

  it('shows the element of a list as it is when it has no name (card #213)', () => {
    expect(typeLabel('list<foo>')).toBe('lista de foo');
    expect(typeLabel('list<list<foo>>')).toBe('lista de listas de foo');
    expect(typeLabel('list<constructor>')).toBe('lista de constructor');
  });

  // Card #201: a type comes from the data catalog or a contract, so a name every object inherits is shown as it is.
  it.each(['constructor', 'toString', '__proto__', 'list<>', 'list', 'lists<text>'])('shows a type without a label, such as %s, as it is', (type) => {
    expect(typeLabel(type)).toBe(type);
  });
});
