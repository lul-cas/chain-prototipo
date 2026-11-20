import { netDecimal, Num, parseNumber } from './decimal';
import { ExpressionError } from './errors';
import { addMonths, civil, dayNumber, daysInMonth, formatInstant, instantFromEpochMilliseconds, parseDate, parseDateTime, parseTime } from './temporal';

describe('calendar', () => {
  it('maps every day of the range to its date and back', () => {
    for (let day = 0; day <= dayNumber(9999, 12, 31); day += 997) {
      const { year, month, day: dayOfMonth } = civil(day);
      expect(dayNumber(year, month, dayOfMonth)).toBe(day);
    }
    expect(civil(0)).toEqual({ year: 1, month: 1, day: 1 });
    expect(civil(dayNumber(9999, 12, 31))).toEqual({ year: 9999, month: 12, day: 31 });
  });

  it('knows the leap years of the proleptic Gregorian calendar', () => {
    expect([1900, 2000, 2024, 2025].map((year) => daysInMonth(year, 2))).toEqual([28, 29, 29, 28]);
  });

  it('clamps month steps to the last day of the month', () => {
    expect(civil(addMonths(dayNumber(2026, 1, 31), 1))).toEqual({ year: 2026, month: 2, day: 28 });
    expect(civil(addMonths(dayNumber(2024, 3, 31), -1))).toEqual({ year: 2024, month: 2, day: 29 });
    expect(() => addMonths(dayNumber(9999, 12, 1), 1)).toThrow(ExpressionError);
  });

  it('reads the clock of Date.now() in UTC', () => {
    expect(formatInstant(instantFromEpochMilliseconds(Date.UTC(2026, 9, 15, 12, 0, 0, 250)))).toBe('2026-10-15T12:00:00.25Z');
  });
});

describe('strict text formats, ASCII digits only (§5.1, card #68)', () => {
  it.each(['2026-10-15', '0001-01-01', '9999-12-31', '2024-02-29'])('reads the date %s', (text) => {
    expect(parseDate(text)).not.toBeNull();
  });

  it.each(['2026-1-15', '02026-01-15', '0000-01-01', '2025-02-29', '2026-10-15 ', '\u0662\u0660\u0662\u0666-10-15', '\uff12\uff10\uff12\uff16-10-15'])('rejects the date %s', (text) => {
    expect(parseDate(text)).toBeNull();
  });

  it.each([
    ['09:00', 9 * 3600],
    ['23:59:59', 23 * 3600 + 59 * 60 + 59],
  ])('reads the time %s', (text, seconds) => {
    expect(parseTime(text)).toBe(seconds * 10_000_000);
  });

  it.each(['9:00', '24:00', '09:00:5', '09:60', '\u0660\u0669:00'])('rejects the time %s', (text) => {
    expect(parseTime(text)).toBeNull();
  });

  it.each(['2026-10-15T13:00:00.\u0661Z', '2026-10-15T13:00:00-\u0660\u0663:00', '2026-10-15T13:00:00.1\u0967Z'])('rejects the datetime %s', (text) => {
    expect(parseDateTime(text)).toBeNull();
  });
});

describe('decimal as .NET holds it', () => {
  it.each([
    ['.5', '0.5'],
    ['5.', '5'],
    ['+5', '5'],
    ['-0', '0'],
    ['0.12345678901234567890123456785', '0.1234567890123456789012345678'],
    ['0.12345678901234567890123456775', '0.1234567890123456789012345678'],
    ['1234567890123456789012345678.95', '1234567890123456789012345679'],
  ])('parses %s as %s', (text, expected) => {
    expect(parseNumber(text)?.toFixed()).toBe(expected);
  });

  it.each([' 5', '1e3', '1,5', '79228162514264337593543950336', '', '-', '.'])('rejects %j', (text) => {
    expect(parseNumber(text)).toBeNull();
  });

  it('raises overflow past the range', () => {
    expect(() => netDecimal(new Num('79228162514264337593543950335.6'))).toThrow(ExpressionError);
  });
});
