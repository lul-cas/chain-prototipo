import { overflow } from './errors';

// Calendar and clock values on .NET's DateTime range (years 1–9999), in 100 ns ticks, never through the browser's time zone
// (ADR-0010 D5). Dates are day numbers, times are ticks of the day, and a datetime keeps its clock and its offset like
// .NET's DateTimeOffset, because month arithmetic runs on the clock (expression-language.md §3a).

export const TICKS_PER_SECOND = 10_000_000n;
export const TICKS_PER_MINUTE = 60n * TICKS_PER_SECOND;
export const TICKS_PER_HOUR = 60n * TICKS_PER_MINUTE;
export const TICKS_PER_DAY = 24n * TICKS_PER_HOUR;

/** 9999-12-31T23:59:59.9999999, as ticks since 0001-01-01. */
const MAX_TICKS = 3_155_378_975_999_999_999n;
/** The ticks of 1970-01-01T00:00:00Z. */
const UNIX_EPOCH_TICKS = 621_355_968_000_000_000n;
const DAYS_BEFORE_MONTH = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

/** A point in time with the offset it was written in: `local` clock ticks and `offset` minutes east of UTC. */
export interface Instant {
  readonly local: bigint;
  readonly offset: number;
}

export function isLeap(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function daysInMonth(year: number, month: number): number {
  return month === 2 ? (isLeap(year) ? 29 : 28) : [31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/** Days since 0001-01-01 of a valid calendar date. */
export function dayNumber(year: number, month: number, day: number): number {
  const y = year - 1;
  const leapDay = month > 2 && isLeap(year) ? 1 : 0;
  return y * 365 + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) + DAYS_BEFORE_MONTH[month - 1] + leapDay + day - 1;
}

/** The calendar date of a day number (the 400/100/4/1-year cycles .NET uses). */
export function civil(dayNo: number): { year: number; month: number; day: number } {
  const n400 = Math.floor(dayNo / 146_097);
  let rest = dayNo - n400 * 146_097;
  const n100 = Math.min(3, Math.floor(rest / 36_524));
  rest -= n100 * 36_524;
  const n4 = Math.floor(rest / 1_461);
  rest -= n4 * 1_461;
  const n1 = Math.min(3, Math.floor(rest / 365));
  rest -= n1 * 365;
  const year = n400 * 400 + n100 * 100 + n4 * 4 + n1 + 1;
  let month = 1;
  while (rest >= daysInMonth(year, month)) {
    rest -= daysInMonth(year, month);
    month++;
  }
  return { year, month, day: rest + 1 };
}

// Arithmetic: out of range is `overflow` (expression-language.md §5.3).

export function addDays(dayNo: number, days: number): number {
  const result = dayNo + days;
  if (result < 0 || result > dayNumber(9999, 12, 31)) {
    throw overflow();
  }
  return result;
}

/** Month steps clamp to the last valid day: 2026-01-31 + 1 month = 2026-02-28 (§3a). Years are 12 months. */
export function addMonths(dayNo: number, months: number): number {
  const { year, month, day } = civil(dayNo);
  const total = year * 12 + (month - 1) + months;
  const newYear = Math.floor(total / 12);
  const newMonth = (total % 12) + 1;
  if (newYear < 1 || newYear > 9999) {
    throw overflow();
  }
  return dayNumber(newYear, newMonth, Math.min(day, daysInMonth(newYear, newMonth)));
}

/** A valid instant: both its clock and its UTC time lie in years 1–9999, as .NET's DateTimeOffset requires. */
export function instant(local: bigint, offset: number): Instant {
  const utc = local - BigInt(offset) * TICKS_PER_MINUTE;
  if (local < 0n || local > MAX_TICKS || utc < 0n || utc > MAX_TICKS) {
    throw overflow();
  }
  return { local, offset };
}

export function utcTicks(value: Instant): bigint {
  return value.local - BigInt(value.offset) * TICKS_PER_MINUTE;
}

/** The same instant in UTC. */
export function toUtc(value: Instant): Instant {
  return { local: utcTicks(value), offset: 0 };
}

/** The same instant on another clock; `overflow` when that clock leaves the range. */
export function toOffset(value: Instant, offset: number): Instant {
  return instant(utcTicks(value) + BigInt(offset) * TICKS_PER_MINUTE, offset);
}

export function addTicks(value: Instant, ticks: bigint): Instant {
  return instant(value.local + ticks, value.offset);
}

/** Month steps on the instant's own clock, keeping the time of day and the offset. */
export function addInstantMonths(value: Instant, months: number): Instant {
  const day = addMonths(Number(value.local / TICKS_PER_DAY), months);
  return instant(BigInt(day) * TICKS_PER_DAY + (value.local % TICKS_PER_DAY), value.offset);
}

/** The date and the time of day of an instant's clock. */
export function clockDate(value: Instant): number {
  return Number(value.local / TICKS_PER_DAY);
}

export function clockTime(value: Instant): number {
  return Number(value.local % TICKS_PER_DAY);
}

/** A date at a time of day on the clock of `offset`, as a UTC instant (C#: `new DateTimeOffset(...).ToUniversalTime()`). */
export function atClock(dayNo: number, timeTicks: number, offset: number): Instant {
  return toUtc(instant(BigInt(dayNo) * TICKS_PER_DAY + BigInt(timeTicks), offset));
}

/** The current instant from milliseconds since 1970 (`Date.now()`), in UTC. */
export function instantFromEpochMilliseconds(milliseconds: number): Instant {
  return instant(BigInt(Math.trunc(milliseconds)) * 10_000n + UNIX_EPOCH_TICKS, 0);
}

// Parsing: ASCII digits only, so both interpreters read the same text (expression-language.md §5.1, card #68).

const DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const TIME = /^([0-9]{2}):([0-9]{2})(?::([0-9]{2}))?$/;
const DATETIME = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]{1,7}))?)?(Z|[+-][0-9]{2}:[0-9]{2})$/;

const validDate = (year: number, month: number, day: number): boolean =>
  year >= 1 && year <= 9999 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);

/** `yyyy-MM-dd`; null otherwise. */
export function parseDate(text: string): number | null {
  const match = DATE.exec(text);
  if (!match) {
    return null;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return validDate(year, month, day) ? dayNumber(year, month, day) : null;
}

/** `HH:mm` or `HH:mm:ss`, as ticks of the day; null otherwise. */
export function parseTime(text: string): number | null {
  const match = TIME.exec(text);
  if (!match) {
    return null;
  }
  const [hour, minute, second] = [Number(match[1]), Number(match[2]), Number(match[3] ?? '0')];
  return hour <= 23 && minute <= 59 && second <= 59 ? ((hour * 60 + minute) * 60 + second) * 10_000_000 : null;
}

/** The strict datetime grammar `yyyy-MM-ddTHH:mm[:ss[.f{1,7}]](Z|±hh:mm)` (§5.1); null otherwise. */
export function parseDateTime(text: string): Instant | null {
  const match = DATETIME.exec(text);
  if (!match) {
    return null;
  }
  const [year, month, day, hour, minute] = [1, 2, 3, 4, 5].map((i) => Number(match[i]));
  const second = Number(match[6] ?? '0');
  if (!validDate(year, month, day) || hour > 23 || minute > 59 || second > 59) {
    return null;
  }

  let offset = 0;
  if (match[8] !== 'Z') {
    const [hours, minutes] = [Number(match[8].slice(1, 3)), Number(match[8].slice(4, 6))];
    if (minutes > 59 || hours > 14 || (hours === 14 && minutes !== 0)) {
      return null;
    }
    offset = (match[8][0] === '-' ? -1 : 1) * (hours * 60 + minutes);
  }

  const fraction = BigInt((match[7] ?? '').padEnd(7, '0'));
  const local =
    BigInt(dayNumber(year, month, day)) * TICKS_PER_DAY + BigInt((hour * 60 + minute) * 60 + second) * TICKS_PER_SECOND + fraction;
  try {
    return instant(local, offset);
  } catch {
    return null; // the UTC instant falls outside years 1–9999
  }
}

// Canonical text (expression-language.md §5.2).

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

export function formatDate(dayNo: number): string {
  const { year, month, day } = civil(dayNo);
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** `HH:mm:ss`; a fraction of a second is not shown. */
export function formatTime(ticks: number): string {
  const seconds = Math.floor(ticks / 10_000_000);
  return `${pad(Math.floor(seconds / 3600), 2)}:${pad(Math.floor(seconds / 60) % 60, 2)}:${pad(seconds % 60, 2)}`;
}

/** UTC `yyyy-MM-ddTHH:mm:ss[.f]Z`, with 1 to 7 fractional digits and no trailing zeros. */
export function formatInstant(value: Instant): string {
  const utc = utcTicks(value);
  const ticksOfDay = Number(utc % TICKS_PER_DAY);
  const fraction = String(ticksOfDay % 10_000_000).padStart(7, '0').replace(/0+$/, '');
  return `${formatDate(Number(utc / TICKS_PER_DAY))}T${formatTime(ticksOfDay)}${fraction ? `.${fraction}` : ''}Z`;
}
