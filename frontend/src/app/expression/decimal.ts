import Decimal from 'decimal.js';
import { overflow } from './errors';

/**
 * Numbers are decimal (expression-language.md §2) and must give the results of .NET's `decimal`, the C# interpreter's type
 * (ADR-0010 D5). Operations run exactly, or at 64 significant digits for division, and then {@link netDecimal} rounds the
 * result to what a .NET decimal holds.
 */
export const Num = Decimal.clone({ precision: 64, rounding: Decimal.ROUND_HALF_EVEN, toExpNeg: -9e15, toExpPos: 9e15 });
export type Num = Decimal;

/** The largest .NET decimal: a 96-bit mantissa. */
const MAX = new Num('79228162514264337593543950335');
const MAX_SCALE = 28;
const TEN = new Num(10);
const ZERO = new Num(0);

/**
 * The value a .NET decimal holds for `value`: at most 28 decimal places and a mantissa below 2^96, rounded half to even as
 * .NET rounds (checked against .NET 10: parsing, multiplication and division). Beyond the range it is `overflow`.
 * Negative zero becomes zero, which .NET prints as "0".
 */
export function netDecimal(value: Num): Num {
  if (!value.isFinite() || value.abs().gt(MAX)) {
    throw overflow();
  }
  for (let places = Math.min(MAX_SCALE, value.decimalPlaces()); ; places--) {
    const rounded = value.toDecimalPlaces(places, Num.ROUND_HALF_EVEN);
    if (places === 0 || rounded.abs().times(TEN.pow(places)).lte(MAX)) {
      if (rounded.abs().gt(MAX)) {
        throw overflow();
      }
      return rounded.isZero() ? ZERO : rounded;
    }
  }
}

/** Invariant number text as .NET reads it here: an optional sign, digits and one decimal point; no spaces, groups or exponent. */
const NUMBER_TEXT = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/;

/** Parses number text like C#'s `TryParseNumber`; null when it isn't a number or doesn't fit a decimal. */
export function parseNumber(text: string): Num | null {
  if (!NUMBER_TEXT.test(text)) {
    return null;
  }
  try {
    return netDecimal(new Num(text));
  } catch {
    return null;
  }
}

/** A number read from JSON data. */
export function numberFromJson(value: number): Num {
  return netDecimal(new Num(value));
}

/** The canonical text of a number: invariant, no exponent, no trailing zeros (C# `0.####…`). */
export function formatNumber(value: Num): string {
  return value.isZero() ? '0' : value.toFixed();
}
