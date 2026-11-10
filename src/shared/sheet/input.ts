// Cell input "as if typed": "10%" -> 0.1 with a percent format, "$5" -> 5
// currency, "1,200" -> 1200 with thousands, "2026-03-15" and "3/15/2026" ->
// dates, "14:30" -> time, "TRUE" -> boolean, "=..." -> formula, a leading "'"
// keeps the rest as text. The value stays unrounded; the pattern only shows it.

import { dateToSerial, isValidDate, timeToSerial } from "./dates.ts";

export type ParsedInput =
  | { readonly kind: "blank" }
  | { readonly kind: "formula"; readonly formula: string }
  | { readonly kind: "number"; readonly value: number; readonly pattern: string | null }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "text"; readonly value: string };

export interface ParsedNumber {
  readonly value: number;
  /** Implied number format, or null for a plain number. */
  readonly pattern: string | null;
}

export function parseInput(input: string): ParsedInput {
  if (input === "") return { kind: "blank" };
  if (input.startsWith("'")) return { kind: "text", value: input.slice(1) };
  if (input.startsWith("=") && input.length > 1) return { kind: "formula", formula: input };
  const trimmed = input.trim();
  if (/^true$/i.test(trimmed)) return { kind: "boolean", value: true };
  if (/^false$/i.test(trimmed)) return { kind: "boolean", value: false };
  const n = parseNumberText(trimmed);
  if (n) return { kind: "number", value: n.value, pattern: n.pattern };
  return { kind: "text", value: input };
}

const NUMBER =
  /^([+-]?)\s*([$€]?)\s*([+-]?)(\d{1,3}(?:,\d{3})+|\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?\s*(€?)\s*(%?)$/;

const TIME = String.raw`(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:\s*([AaPp][Mm]))?`;
const ISO_DATE = new RegExp(String.raw`^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ]${TIME})?$`);
const US_DATE = new RegExp(String.raw`^(\d{1,2})/(\d{1,2})/(\d{4})(?: ${TIME})?$`);
const TIME_ONLY = new RegExp(`^${TIME}$`);

/**
 * Parses text that reads as a number, percent, currency, date or time.
 * Used for typed input, numeric coercion of text and VALUE().
 */
export function parseNumberText(text: string): ParsedNumber | null {
  const s = text.trim();
  if (s === "") return null;
  return parseDate(s) ?? parseTime(s) ?? parsePlainNumber(s);
}

function parsePlainNumber(s: string): ParsedNumber | null {
  const m = NUMBER.exec(s);
  if (!m) return null;
  const [, sign1 = "", currency = "", sign2 = "", int = "", dec, exp, euroAfter = "", percent = ""] = m;
  if (sign1 && sign2) return null;
  if (int === "" && (dec === undefined || dec === "")) return null;
  if (currency && euroAfter) return null;
  if ((currency || euroAfter) && percent) return null;
  const sign = sign1 || sign2;
  let value = Number(`${int.replace(/,/g, "") || "0"}.${dec ?? ""}${exp !== undefined ? `e${exp}` : ""}`);
  if (sign === "-") value = -value;
  if (percent) value /= 100;
  if (!Number.isFinite(value)) return null;
  const decimals = dec?.length ?? 0;
  const zeros = decimals > 0 ? `.${"0".repeat(decimals)}` : "";
  let pattern: string | null = null;
  if (percent) pattern = `0${zeros}%`;
  else if (currency === "$") pattern = `$#,##0.${"0".repeat(Math.max(2, decimals))}`;
  else if (currency === "€" || euroAfter) pattern = `€#,##0.${"0".repeat(Math.max(2, decimals))}`;
  else if (int.includes(",")) pattern = `#,##0${zeros}`;
  else if (exp !== undefined) pattern = `0.00E+00`;
  return { value: value === 0 ? 0 : value, pattern };
}

function readTime(
  h: string | undefined,
  mi: string | undefined,
  se: string | undefined,
  frac: string | undefined,
  ampm: string | undefined,
): { serial: number; pattern: string } | null {
  if (h === undefined || mi === undefined) return null;
  let hour = Number(h);
  const minute = Number(mi);
  const second = se === undefined ? 0 : Number(`${se}.${frac ?? "0"}`);
  if (minute > 59 || second >= 60) return null;
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    const pm = ampm.toLowerCase() === "pm";
    hour = (hour % 12) + (pm ? 12 : 0);
  } else if (hour > 23) {
    return null;
  }
  const pattern = `h:mm${se !== undefined ? ":ss" : ""}${ampm ? " AM/PM" : ""}`;
  return { serial: timeToSerial(hour, minute, second), pattern };
}

function parseDate(s: string): ParsedNumber | null {
  let y: number;
  let mo: number;
  let d: number;
  let datePattern: string;
  let rest: Array<string | undefined>;
  const iso = ISO_DATE.exec(s);
  if (iso) {
    [y, mo, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    datePattern = "yyyy-mm-dd";
    rest = iso.slice(4);
  } else {
    const us = US_DATE.exec(s);
    if (!us) return null;
    [mo, d, y] = [Number(us[1]), Number(us[2]), Number(us[3])];
    datePattern = "m/d/yyyy";
    rest = us.slice(4);
  }
  if (!isValidDate(y, mo, d)) return null;
  const serial = dateToSerial(y, mo, d);
  if (rest[0] === undefined) return { value: serial, pattern: datePattern };
  const t = readTime(rest[0], rest[1], rest[2], rest[3], rest[4]);
  if (!t) return null;
  return { value: serial + t.serial, pattern: `${datePattern} ${t.pattern}` };
}

function parseTime(s: string): ParsedNumber | null {
  const m = TIME_ONLY.exec(s);
  if (!m) return null;
  const t = readTime(m[1], m[2], m[3], m[4], m[5]);
  return t ? { value: t.serial, pattern: t.pattern } : null;
}

/** Turns an edit's cell value into input text; null clears. Returns undefined when not a valid input. */
export function inputFromValue(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === "string") return value === "" ? null : value;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    return String(value);
  }
  return undefined;
}
