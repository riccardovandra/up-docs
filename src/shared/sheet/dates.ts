// Dates are serial numbers: days since 1899-12-30, the fraction is the time of
// day. 2026-03-15 = 46096. All conversions are in UTC so the browser and the
// Worker agree.

const MS_PER_DAY = 86_400_000;
const EPOCH_MS = Date.UTC(1899, 11, 30);

/** Serial of a calendar date; months and days overflow like DATE (month 13 = next January). */
export function dateToSerial(year: number, month: number, day: number): number {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(0, 0, 0, 0);
  return Math.round((d.getTime() - EPOCH_MS) / MS_PER_DAY);
}

export function timeToSerial(hour: number, minute: number, second: number): number {
  return (hour * 3600 + minute * 60 + second) / 86_400;
}

export interface DateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  /** 0 = Sunday. */
  readonly weekday: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/** Splits a serial into calendar parts, rounding to the nearest second. */
export function serialToParts(serial: number): DateParts {
  let days = Math.floor(serial);
  let seconds = Math.round((serial - days) * 86_400);
  if (seconds >= 86_400) {
    days += 1;
    seconds -= 86_400;
  }
  const d = new Date(EPOCH_MS + days * MS_PER_DAY);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: d.getUTCDay(),
    hour: Math.floor(seconds / 3600),
    minute: Math.floor((seconds % 3600) / 60),
    second: seconds % 60,
  };
}

/** Epoch milliseconds -> serial at the given UTC offset. */
export function msToSerial(ms: number, utcOffsetMinutes = 0): number {
  return (ms + utcOffsetMinutes * 60_000 - EPOCH_MS) / MS_PER_DAY;
}

/** Whether a calendar date exists (no overflow). */
export function isValidDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const p = serialToParts(dateToSerial(year, month, day));
  return p.year === year && p.month === month && p.day === day;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

export function isoDate(serial: number): string {
  const p = serialToParts(serial);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

export function isoTime(serial: number): string {
  const p = serialToParts(serial);
  return `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

export function isoDateTime(serial: number): string {
  const p = serialToParts(serial);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}
