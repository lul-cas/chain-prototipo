import { Num } from './decimal';
import { fromJson } from './values';

describe('fromJson', () => {
  it('reads an exact decimal as a number, so values typed in a form keep every digit in conditions', () => {
    const value = fromJson(new Num('1234567890123456789.0123456789'));

    expect(value.kind).toBe('number');
    expect(value.kind === 'number' ? value.value.toFixed() : null).toBe('1234567890123456789.0123456789');
  });

  it('still reads JSON numbers, text and objects by their JSON kind', () => {
    expect(fromJson(12.5)).toMatchObject({ kind: 'number' });
    expect(fromJson('12.5')).toEqual({ kind: 'text', value: '12.5' });
    expect(fromJson({ a: 1 })).toMatchObject({ kind: 'object' });
  });
});
