import { formatPath, parsePath } from './output-path';

describe("an output path's text form (automation-ui.md §7.4)", () => {
  const cases: [(string | number)[], string][] = [
    [['resultado', 'situacao'], 'resultado.situacao'],
    [['itens', 0, 'nome'], 'itens[0].nome'],
    [['nome.completo'], '["nome.completo"]'],
    [['itens', 0, 'nome.completo'], 'itens[0]["nome.completo"]'],
    [['a', '0'], 'a.0'], // a plain segment is always a name
    [['a', 0], 'a[0]'],
    [[0], '[0]'],
    [['0'], '0'],
    [['', 'x'], '[""].x'],
    [['say "hi"'], '["say \\"hi\\""]'],
    [['a b', 'c[1]', 'd]'], '["a b"]["c[1]"]["d]"]'],
    [['ação', 'nível_2'], 'ação.nível_2'],
  ];

  it('writes names with dots, list positions in brackets, and names that need it as JSON strings in brackets', () => {
    for (const [segments, text] of cases) {
      expect(formatPath(segments)).toBe(text);
    }
  });

  it('reads back what it writes', () => {
    for (const [segments, text] of cases) {
      expect(parsePath(text)).toEqual({ segments });
    }
  });

  it('says why a text is no path', () => {
    const cases: [string, string][] = [
      ['', 'Informe o caminho na resposta, como resultado.situacao.'],
      ['.a', 'O caminho tem um nome vazio entre pontos.'],
      ['a.', 'O caminho tem um nome vazio entre pontos.'],
      ['a..b', 'O caminho tem um nome vazio entre pontos.'],
      ['a b', 'Um nome com ponto, colchete, aspas ou espaço vai entre colchetes e aspas, como ["nome completo"].'],
      ['a"b', 'Um nome com ponto, colchete, aspas ou espaço vai entre colchetes e aspas, como ["nome completo"].'],
      ['a]', 'Um nome com ponto, colchete, aspas ou espaço vai entre colchetes e aspas, como ["nome completo"].'],
      ['a[x]', 'Entre colchetes vai a posição de um item, a partir de 0, como itens[0], ou um nome entre aspas.'],
      ['a[-1]', 'Entre colchetes vai a posição de um item, a partir de 0, como itens[0], ou um nome entre aspas.'],
      ['a[01]', 'Entre colchetes vai a posição de um item, a partir de 0, como itens[0], ou um nome entre aspas.'],
      ['a[0', 'Entre colchetes vai a posição de um item, a partir de 0, como itens[0], ou um nome entre aspas.'],
      ['a[2147483648]', 'A posição de um item vai até 2147483647.'],
      ['["a', 'Feche o nome entre aspas e colchetes, como ["nome.completo"].'],
      ['["a"', 'Feche o nome entre aspas e colchetes, como ["nome.completo"].'],
      ['["a\\x"]', 'O nome entre colchetes é um texto JSON, como ["nome.completo"].'],
      ['a[0]b', 'Separe os nomes com ponto, como resultado.situacao.'],
    ];
    for (const [text, error] of cases) {
      expect(parsePath(text)).toEqual({ error });
    }
  });

  it('keeps the largest list position', () => {
    expect(parsePath('a[2147483647]')).toEqual({ segments: ['a', 2147483647] });
  });
});
