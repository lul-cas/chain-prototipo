import { parseDateTime } from '../expression';
import { FieldValidation, FieldOption, FormComponent } from './model';
import { Clock, checkField } from './rules';

/** 2026-10-16 12:00 UTC, which is 09:00 on 2026-10-16 in the evaluation zone (UTC−03:00). */
const CLOCK: Clock = { now: parseDateTime('2026-10-16T12:00:00Z')!, zone: -180 };

const OPTIONS: FieldOption[] = [
  { value: 'a', label: 'A' },
  { value: 'b', label: 'B' },
  { value: 'c', label: 'C' },
];

function field(type: FormComponent['type'], validate: FieldValidation = {}): FormComponent {
  return { type, key: 'campo', label: 'Campo', validate, options: OPTIONS };
}

function check(component: FormComponent, value: unknown, required = false): readonly string[] {
  return checkField(component, value, required, CLOCK);
}

describe('client field rules (the codes of forms.md F1)', () => {
  describe('required', () => {
    it.each([
      ['text', ''],
      ['number', ''],
      ['select', ''],
      ['radio', ''],
      ['date', ''],
      ['checkbox', false],
      ['checklist', []],
    ] as const)('an empty %s is required', (type, empty) => {
      expect(check(field(type), empty, true)).toEqual(['required']);
      expect(check(field(type), empty, false)).toEqual([]);
    });
  });

  describe('text', () => {
    it('checks the length in UTF-16 code units, as .NET does', () => {
      expect(check(field('text', { minLength: 3 }), 'ab')).toEqual(['too_short']);
      expect(check(field('text', { minLength: 3 }), 'abc')).toEqual([]);
      expect(check(field('textarea', { maxLength: 3 }), 'abcd')).toEqual(['too_long']);
      expect(check(field('textarea', { maxLength: 3 }), 'abc')).toEqual([]);
    });

    it('checks formats and whole-value patterns', () => {
      expect(check(field('text', { format: 'cpf' }), '529.982.247-24')).toEqual(['invalid_format']);
      expect(check(field('text', { format: 'cpf' }), '529.982.247-25')).toEqual([]);
      expect(check(field('text', { pattern: '[A-Z]{2}[0-9]+' }), 'AB12x')).toEqual(['invalid_format']);
      expect(check(field('text', { pattern: '[A-Z]{2}[0-9]+' }), 'xAB12')).toEqual(['invalid_format']);
      expect(check(field('text', { pattern: '[A-Z]{2}[0-9]+' }), 'AB12')).toEqual([]);
      expect(check(field('text', { pattern: 'a|b' }), 'ab')).toEqual(['invalid_format']);
    });

    it('leaves a pattern the browser cannot compile to the server', () => {
      expect(check(field('text', { pattern: '(' }), 'anything')).toEqual([]);
    });

    it('matches nothing with a pattern that compiles only inside the wrap, as the server does', () => {
      expect(check(field('text', { pattern: 'a)|(?:b' }), 'aXYZ')).toEqual(['invalid_format']);
    });

    it('reports length and format together, in the server order', () => {
      expect(check(field('text', { minLength: 5, format: 'cep' }), '123')).toEqual(['too_short', 'invalid_format']);
    });
  });

  describe('number', () => {
    it('needs a number in pt-BR form', () => {
      expect(check(field('number'), 'abc')).toEqual(['type_mismatch']);
      expect(check(field('number'), '1.5')).toEqual(['type_mismatch']);
      expect(check(field('number'), '1,5')).toEqual([]);
    });

    it('checks the limits, the decimals and the step', () => {
      expect(check(field('number', { min: 10 }), '9,99')).toEqual(['too_small']);
      expect(check(field('number', { min: 10 }), '10')).toEqual([]);
      expect(check(field('number', { max: 100 }), '100,01')).toEqual(['too_large']);
      expect(check(field('number', { decimalDigits: 2 }), '1,234')).toEqual(['too_many_decimals']);
      expect(check(field('number', { decimalDigits: 2 }), '1,230')).toEqual([]);
      expect(check(field('number', { decimalDigits: 0 }), '3,0')).toEqual([]);
    });

    it('counts steps from min, or from zero', () => {
      expect(check(field('number', { min: 1, step: 0.5 }), '1,5')).toEqual([]);
      expect(check(field('number', { min: 1, step: 0.5 }), '1,2')).toEqual(['invalid_step']);
      expect(check(field('number', { step: 5 }), '-10')).toEqual([]);
      expect(check(field('number', { step: 5 }), '11')).toEqual(['invalid_step']);
      expect(check(field('number', { min: 1, step: 2 }), '3')).toEqual([]);
      expect(check(field('number', { min: 1, step: 2 }), '4')).toEqual(['invalid_step']);
    });

    it('reports every broken limit, in the server order', () => {
      expect(check(field('number', { min: 10, decimalDigits: 0, step: 2 }), '7,5')).toEqual(['too_small', 'too_many_decimals', 'invalid_step']);
    });
  });

  describe('choices', () => {
    it('accepts only the listed options', () => {
      expect(check(field('select'), 'z')).toEqual(['invalid_option']);
      expect(check(field('radio'), 'b')).toEqual([]);
    });

    it('checks checklists: options and counts', () => {
      expect(check(field('checklist'), ['a', 'z'])).toEqual(['invalid_option']);
      expect(check(field('checklist', { minSelected: 2 }), ['a'])).toEqual(['too_few']);
      expect(check(field('checklist', { maxSelected: 1 }), ['a', 'b'])).toEqual(['too_many']);
      expect(check(field('checklist', { minSelected: 1, maxSelected: 2 }), ['a', 'c'])).toEqual([]);
    });

    it('requires a checked box only when required', () => {
      expect(check(field('checkbox'), true, true)).toEqual([]);
    });
  });

  describe('date, time and datetime', () => {
    it('needs valid text', () => {
      expect(check(field('date'), '2026-13-01')).toEqual(['type_mismatch']);
      expect(check(field('time'), '25:00')).toEqual(['type_mismatch']);
      expect(check(field('datetime'), '2026-10-16T14:30')).toEqual(['type_mismatch']);
      expect(check(field('datetime'), '2026-10-16T14:30:00-03:00')).toEqual([]);
    });

    it('checks absolute bounds', () => {
      expect(check(field('date', { min: '2026-01-01' }), '2025-12-31')).toEqual(['too_early']);
      expect(check(field('date', { min: '2026-01-01' }), '2026-01-01')).toEqual([]);
      expect(check(field('time', { max: '18:00' }), '18:00:01')).toEqual(['too_late']);
      expect(check(field('time', { min: '08:00:00' }), '08:00')).toEqual([]);
      expect(check(field('datetime', { max: '2026-10-16T12:00:00Z' }), '2026-10-16T09:00:01-03:00')).toEqual(['too_late']);
      expect(check(field('datetime', { max: '2026-10-16T12:00:00Z' }), '2026-10-16T09:00:00-03:00')).toEqual([]);
    });

    it('resolves relative date bounds from today in the evaluation zone', () => {
      const notAfterToday = field('date', { max: { system: 'currentDate' } });
      expect(check(notAfterToday, '2026-10-16')).toEqual([]);
      expect(check(notAfterToday, '2026-10-17')).toEqual(['too_late']);
      const withinAMonth = field('date', { min: { system: 'currentDate', offset: { amount: -1, unit: 'months' } } });
      expect(check(withinAMonth, '2026-09-15')).toEqual(['too_early']);
      expect(check(withinAMonth, '2026-09-16')).toEqual([]);
    });

    it('takes "today" in the evaluation zone, not in UTC', () => {
      // 2026-10-17 01:00 UTC is still 2026-10-16 (22:00) in UTC−03:00.
      const lateEvening: Clock = { now: parseDateTime('2026-10-17T01:00:00Z')!, zone: -180 };
      const notAfterToday = field('date', { max: { system: 'currentDate' } });

      expect(checkField(notAfterToday, '2026-10-16', false, lateEvening)).toEqual([]);
      expect(checkField(notAfterToday, '2026-10-17', false, lateEvening)).toEqual(['too_late']);
    });

        it('resolves relative datetime bounds from the current instant', () => {
      const withinAnHour = field('datetime', { max: { system: 'currentDateTime', offset: { amount: 1, unit: 'hours' } } });
      expect(check(withinAnHour, '2026-10-16T13:00:00Z')).toEqual([]);
      expect(check(withinAnHour, '2026-10-16T13:00:01Z')).toEqual(['too_late']);
    });
  });
});
