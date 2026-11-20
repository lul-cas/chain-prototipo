import { Num, formatNumber, parseNumber } from '../expression/decimal';

/** pt-BR number text: an optional sign, digits and a comma before the decimals. No thousands separator (forms.md F3). */
const NUMBER_INPUT = /^[+-]?[0-9]+(?:,[0-9]+)?$/;

/** The exact decimal a number field holds, or null when the text is not a number or doesn't fit a .NET decimal. */
export function parseNumberInput(text: string): Num | null {
  const trimmed = text.trim();
  return NUMBER_INPUT.test(trimmed) ? parseNumber(trimmed.replace(',', '.')) : null;
}

/** The text a number field shows for `value`: a comma before the decimals, no grouping. */
export function formatNumberInput(value: Num): string {
  return formatNumber(value).replace('.', ',');
}
