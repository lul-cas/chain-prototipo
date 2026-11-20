import { rateProblem, tokenLabelProblem } from './bot-rules';

describe('bot rules (admin-ui.md §6; identity.md I3)', () => {
  it('takes a token label of 1 to 100 characters around spaces, of text the server can store', () => {
    expect(tokenLabelProblem('produção')).toBeNull();
    expect(tokenLabelProblem(` ${'x'.repeat(100)} `)).toBeNull();

    for (const label of ['', '   ', 'x'.repeat(101), 'produção\u0000']) {
      expect(tokenLabelProblem(label)).toBe('invalid_label');
    }
  });

  it('takes a rate of 1 to 600 calls a minute, as a whole number', () => {
    for (const rate of ['1', '60', ' 600 ']) {
      expect(rateProblem(rate)).toBeNull();
    }
    for (const rate of ['', '0', '601', '1.5', '-1', 'dez', '1e2']) {
      expect(rateProblem(rate)).toBe('invalid_calls_per_minute');
    }
  });
});
