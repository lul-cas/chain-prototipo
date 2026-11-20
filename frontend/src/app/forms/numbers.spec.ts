import { Num } from '../expression/decimal';
import { formatNumberInput, parseNumberInput } from './numbers';

describe('number input (pt-BR)', () => {
  it.each([
    ['1234', '1234'],
    ['1234,56', '1234.56'],
    ['-0,5', '-0.5'],
    ['+3', '3'],
    [' 12 ', '12'],
    ['0,10', '0.1'],
    ['1234567890123456789,0123456789', '1234567890123456789.0123456789'],
  ])('reads %j as %s', (text, expected) => {
    expect(parseNumberInput(text)?.toFixed()).toBe(expected);
  });

  it.each(['', ' ', 'abc', '1.234', '1.234,56', '1,2,3', ',5', '5,', '1e5', '1 234', '79228162514264337593543950336'])(
    'refuses %j',
    (text) => {
      expect(parseNumberInput(text)).toBeNull();
    },
  );

  it('writes numbers with a comma for the decimals and no grouping', () => {
    expect(formatNumberInput(new Num('1234.56'))).toBe('1234,56');
    expect(formatNumberInput(new Num('-0.5'))).toBe('-0,5');
    expect(formatNumberInput(new Num('100'))).toBe('100');
  });
});
