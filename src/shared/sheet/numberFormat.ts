// Number formats: spreadsheet patterns such as 0, 0.00, #,##0, 0%, 0.0%,
// $#,##0.00, 0.00E+00, yyyy-mm-dd, m/d/yyyy, h:mm AM/PM. `display` turns a
// value into the string a cell shows; values are never rounded in storage.

import { serialToParts } from "./dates.ts";
import type { Scalar } from "./types.ts";

export type PatternKind = "number" | "date" | "time" | "dateTime" | "text";

type Token =
  | { readonly t: "lit"; readonly s: string }
  | { readonly t: "digit"; readonly c: "0" | "#" | "?" }
  | { readonly t: "point" }
  | { readonly t: "comma" }
  | { readonly t: "percent" }
  | { readonly t: "exp"; readonly sign: "+" | "-"; readonly digits: number }
  | { readonly t: "text" }
  | { readonly t: "date"; readonly s: string }
  | { readonly t: "ampm"; readonly s: string };

interface Section {
  readonly tokens: ReadonlyArray<Token>;
  readonly kind: PatternKind;
}

const sectionCache = new Map<string, ReadonlyArray<Section>>();

function splitSections(pattern: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (ch === '"') {
      const end = pattern.indexOf('"', i + 1);
      const stop = end < 0 ? pattern.length : end;
      cur += pattern.slice(i, stop + 1);
      i = stop;
    } else if (ch === "\\") {
      cur += pattern.slice(i, i + 2);
      i++;
    } else if (ch === ";") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

const DATE_TOKEN = /^(yyyy|yy|mmmmm|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s)/i;

function tokenize(section: string): Section {
  const tokens: Token[] = [];
  let i = 0;
  while (i < section.length) {
    const ch = section[i] as string;
    const rest = section.slice(i);
    if (ch === '"') {
      const end = section.indexOf('"', i + 1);
      const stop = end < 0 ? section.length : end;
      tokens.push({ t: "lit", s: section.slice(i + 1, stop) });
      i = stop + 1;
    } else if (ch === "\\") {
      tokens.push({ t: "lit", s: section[i + 1] ?? "" });
      i += 2;
    } else if (ch === "[") {
      const end = section.indexOf("]", i);
      const stop = end < 0 ? section.length : end;
      const inner = section.slice(i + 1, stop);
      const currency = /^\$([^-\]]*)/.exec(inner);
      if (currency) tokens.push({ t: "lit", s: currency[1] ?? "" });
      else if (/^h+$/i.test(inner) || /^m+$/i.test(inner) || /^s+$/i.test(inner)) {
        tokens.push({ t: "date", s: `[${inner.toLowerCase()}]` });
      }
      i = stop + 1;
    } else if (ch === "_") {
      tokens.push({ t: "lit", s: " " });
      i += 2;
    } else if (ch === "*") {
      i += 2;
    } else if (ch === "0" || ch === "#" || ch === "?") {
      tokens.push({ t: "digit", c: ch });
      i++;
    } else if (ch === ".") {
      tokens.push({ t: "point" });
      i++;
    } else if (ch === ",") {
      tokens.push({ t: "comma" });
      i++;
    } else if (ch === "%") {
      tokens.push({ t: "percent" });
      i++;
    } else if (ch === "@") {
      tokens.push({ t: "text" });
      i++;
    } else if (/^E[+-]/i.test(rest)) {
      const m = /^E([+-])(0+)/i.exec(rest);
      if (m) {
        tokens.push({ t: "exp", sign: m[1] as "+" | "-", digits: (m[2] as string).length });
        i += m[0].length;
      } else {
        tokens.push({ t: "lit", s: ch });
        i++;
      }
    } else if (/^(AM\/PM|A\/P)/i.test(rest)) {
      const m = /^(AM\/PM|A\/P)/i.exec(rest) as RegExpExecArray;
      tokens.push({ t: "ampm", s: m[0] });
      i += m[0].length;
    } else if (DATE_TOKEN.test(rest)) {
      const m = DATE_TOKEN.exec(rest) as RegExpExecArray;
      tokens.push({ t: "date", s: m[0].toLowerCase() });
      i += m[0].length;
    } else {
      tokens.push({ t: "lit", s: ch });
      i++;
    }
  }
  // Decide whether each "m" is a month or minutes: minutes after h or before s.
  const resolved: Token[] = tokens.map((tok, idx) => {
    if (tok.t !== "date" || !/^m{1,2}$/.test(tok.s)) return tok;
    const prev = findDate(tokens, idx, -1);
    const next = findDate(tokens, idx, 1);
    const minutes = (prev !== null && /^\[?h/.test(prev)) || (next !== null && /^\[?s/.test(next));
    return minutes ? { t: "date", s: tok.s === "mm" ? "MM" : "M" } : tok;
  });
  const hasDate = resolved.some((t) => t.t === "date" && /^(y|d|m{1,5}$)/.test(t.s));
  const hasTime = resolved.some((t) => (t.t === "date" && /^(\[?[hsM])/.test(t.s)) || t.t === "ampm");
  const hasDigits = resolved.some((t) => t.t === "digit");
  const hasText = resolved.some((t) => t.t === "text");
  let kind: PatternKind = "number";
  if (!hasDigits && (hasDate || hasTime)) kind = hasDate && hasTime ? "dateTime" : hasDate ? "date" : "time";
  else if (!hasDigits && hasText) kind = "text";
  return { tokens: resolved, kind };
}

function findDate(tokens: ReadonlyArray<Token>, from: number, step: 1 | -1): string | null {
  for (let i = from + step; i >= 0 && i < tokens.length; i += step) {
    const t = tokens[i] as Token;
    if (t.t === "date") return t.s;
  }
  return null;
}

function sections(pattern: string): ReadonlyArray<Section> {
  let cached = sectionCache.get(pattern);
  if (!cached) {
    cached = splitSections(pattern).map(tokenize);
    if (sectionCache.size > 500) sectionCache.clear();
    sectionCache.set(pattern, cached);
  }
  return cached;
}

/** What a pattern shows: plain numbers, dates, times, date-times or text. */
export function patternKind(pattern: string | null | undefined): PatternKind {
  if (!pattern) return "number";
  const first = sections(pattern)[0];
  return first ? first.kind : "number";
}

// ---- General (no pattern) ----

/** Shows a number with up to 10 significant digits, as a cell does without a format. */
export function formatGeneral(n: number): string {
  if (!Number.isFinite(n)) return "#NUM!";
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 1e15 || abs < 1e-9) return formatExponent(n, 2, 2, "+");
  if (Number.isInteger(n)) return String(n);
  const intDigits = abs < 1 ? 0 : Math.floor(Math.log10(abs)) + 1;
  const decimals = Math.max(0, Math.min(10, 10 - intDigits));
  const fixed = roundTo(n, decimals).toFixed(decimals);
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

function roundTo(n: number, decimals: number): number {
  const f = 10 ** decimals;
  const r = Math.round(Math.abs(n) * f * (1 + Number.EPSILON)) / f;
  return n < 0 ? -r : r;
}

function formatExponent(n: number, minDec: number, expDigits: number, sign: "+" | "-"): string {
  const [mant, e] = Math.abs(n).toExponential(minDec).split("e") as [string, string];
  const exp = Number(e);
  const expText = String(Math.abs(exp)).padStart(expDigits, "0");
  const expSign = exp < 0 ? "-" : sign === "+" ? "+" : "";
  return `${n < 0 ? "-" : ""}${mant.toUpperCase()}E${expSign}${expText}`;
}

// ---- Display ----

/** The string a cell shows for a value under a pattern (null = general). */
export function display(value: Scalar, pattern?: string | null): string {
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "object") return value.error;
  const secs = pattern ? sections(pattern) : [];
  if (typeof value === "string") {
    const textSection = secs.length >= 4 ? secs[3] : secs.find((s) => s.kind === "text");
    return textSection ? renderText(textSection, value) : value;
  }
  if (secs.length === 0) return formatGeneral(value);
  let section = secs[0] as Section;
  let n = value;
  let explicitNegative = false;
  if (value < 0 && secs.length >= 2) {
    section = secs[1] as Section;
    n = -value;
    explicitNegative = true;
  } else if (value === 0 && secs.length >= 3) {
    section = secs[2] as Section;
  }
  switch (section.kind) {
    case "date":
    case "time":
    case "dateTime":
      return renderDate(section, n);
    case "text":
      return renderText(section, formatGeneral(n));
    default:
      return renderNumber(section, n, explicitNegative);
  }
}

function renderText(section: Section, text: string): string {
  return section.tokens.map((t) => (t.t === "text" ? text : t.t === "lit" ? t.s : "")).join("");
}

function renderNumber(section: Section, value: number, explicitNegative: boolean): string {
  const tokens = section.tokens;
  const first = tokens.findIndex((t) => t.t === "digit" || t.t === "point");
  if (first < 0) {
    // No placeholders: literal text only, e.g. "Total".
    return tokens.map((t) => (t.t === "lit" ? t.s : t.t === "percent" ? "%" : "")).join("");
  }
  let last = -1;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i] as Token;
    if (t.t === "digit" || t.t === "point" || t.t === "exp") {
      last = i;
      break;
    }
  }
  let n = value;
  for (const t of tokens) if (t.t === "percent") n *= 100;
  let intZeros = 0;
  let decZeros = 0;
  let decAll = 0;
  let grouping = false;
  let scale = 0;
  let afterPoint = false;
  let exp: Extract<Token, { t: "exp" }> | null = null;
  for (let i = first; i <= last + 1 && i < tokens.length; i++) {
    const t = tokens[i] as Token;
    if (t.t === "point") afterPoint = true;
    else if (t.t === "digit") {
      if (afterPoint) {
        decAll++;
        if (t.c === "0") decZeros++;
      } else if (t.c === "0") intZeros++;
    } else if (t.t === "comma" && !afterPoint) {
      // A comma between digits groups thousands; commas after the last digit scale by 1000.
      if (tokens[i + 1]?.t === "digit") grouping = true;
      else scale++;
    } else if (t.t === "exp") exp = t;
  }
  n /= 1000 ** scale;
  const negative = n < 0;
  const abs = Math.abs(n);
  let body: string;
  if (exp) {
    body = formatExponent(abs, decAll, exp.digits, exp.sign);
  } else {
    const rounded = roundTo(abs, decAll);
    let [intPart, decPart = ""] = rounded.toFixed(decAll).split(".") as [string, string?];
    while (decPart.length > decZeros && decPart.endsWith("0")) decPart = decPart.slice(0, -1);
    if (intPart === "0" && intZeros === 0) intPart = "";
    intPart = intPart.padStart(intZeros, "0");
    if (grouping) intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    body = decPart.length > 0 ? `${intPart}.${decPart}` : intPart || "0";
  }
  const isZero = Number(body.replace(/[^0-9.]/g, "") || "0") === 0;
  const prefix = tokens
    .slice(0, first)
    .map((t) => (t.t === "lit" ? t.s : t.t === "percent" ? "%" : ""))
    .join("");
  const suffix = tokens
    .slice(last + 1)
    .map((t) => (t.t === "lit" ? t.s : t.t === "percent" ? "%" : ""))
    .join("");
  const minus = negative && !explicitNegative && !isZero ? "-" : "";
  return `${minus}${prefix}${body}${suffix}`;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function renderDate(section: Section, serial: number): string {
  const p = serialToParts(serial);
  const twelveHour = section.tokens.some((t) => t.t === "ampm");
  const hour12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const hour = twelveHour ? hour12 : p.hour;
  const pad = (n: number) => String(n).padStart(2, "0");
  let out = "";
  for (const t of section.tokens) {
    if (t.t === "lit") out += t.s;
    else if (t.t === "comma") out += ",";
    else if (t.t === "point") out += ".";
    else if (t.t === "percent") out += "%";
    else if (t.t === "ampm") {
      const pm = p.hour >= 12;
      out += t.s.length > 3 ? (pm ? "PM" : "AM") : pm ? "P" : "A";
    } else if (t.t === "date") {
      switch (t.s) {
        case "yyyy":
          out += String(p.year).padStart(4, "0");
          break;
        case "yy":
          out += pad(p.year % 100);
          break;
        case "mmmmm":
          out += (MONTHS[p.month - 1] as string)[0];
          break;
        case "mmmm":
          out += MONTHS[p.month - 1];
          break;
        case "mmm":
          out += (MONTHS[p.month - 1] as string).slice(0, 3);
          break;
        case "mm":
          out += pad(p.month);
          break;
        case "m":
          out += String(p.month);
          break;
        case "dddd":
          out += DAYS[p.weekday];
          break;
        case "ddd":
          out += (DAYS[p.weekday] as string).slice(0, 3);
          break;
        case "dd":
          out += pad(p.day);
          break;
        case "d":
          out += String(p.day);
          break;
        case "hh":
          out += pad(hour);
          break;
        case "h":
          out += String(hour);
          break;
        case "MM":
          out += pad(p.minute);
          break;
        case "M":
          out += String(p.minute);
          break;
        case "ss":
          out += pad(p.second);
          break;
        case "s":
          out += String(p.second);
          break;
        case "[h]":
        case "[hh]":
          out += String(Math.floor(serial * 24));
          break;
        case "[m]":
        case "[mm]":
          out += String(Math.floor(serial * 1440));
          break;
        case "[s]":
        case "[ss]":
          out += String(Math.floor(serial * 86400));
          break;
      }
    }
  }
  return out;
}

// ---- Toolbar helpers ----

function decimalsShown(value: Scalar): number {
  if (typeof value !== "number") return 0;
  const text = formatGeneral(value);
  const dot = text.indexOf(".");
  return dot < 0 || /e/i.test(text) ? 0 : text.length - dot - 1;
}

function mapNumberSections(pattern: string, fn: (section: string) => string): string {
  return splitSections(pattern)
    .map((s) => (tokenize(s).kind === "number" && /[0#?]/.test(s) ? fn(s) : s))
    .join(";");
}

/** Index just after the last digit placeholder outside quotes, or -1. */
function lastPlaceholder(section: string): number {
  let inQuote = false;
  let last = -1;
  for (let i = 0; i < section.length; i++) {
    const ch = section[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === "\\") i++;
    else if (!inQuote && (ch === "0" || ch === "#" || ch === "?")) last = i;
    if (!inQuote && ch === "E" && /^E[+-]/.test(section.slice(i))) break;
  }
  return last < 0 ? -1 : last + 1;
}

/** Pattern with one more decimal place; a general cell starts from the decimals it shows. */
export function increaseDecimals(pattern: string | null | undefined, value: Scalar): string {
  if (!pattern) {
    const d = decimalsShown(value) + 1;
    return `0.${"0".repeat(d)}`;
  }
  if (patternKind(pattern) !== "number") return pattern;
  return mapNumberSections(pattern, (s) => {
    const end = lastPlaceholder(s);
    if (end < 0) return s;
    return s.slice(0, end).includes(".") ? `${s.slice(0, end)}0${s.slice(end)}` : `${s.slice(0, end)}.0${s.slice(end)}`;
  });
}

/** Pattern with one fewer decimal place; returns the pattern unchanged at zero decimals. */
export function decreaseDecimals(pattern: string | null | undefined, value: Scalar): string {
  if (!pattern) {
    const d = decimalsShown(value) - 1;
    return d > 0 ? `0.${"0".repeat(d)}` : "0";
  }
  if (patternKind(pattern) !== "number") return pattern;
  return mapNumberSections(pattern, (s) => {
    const end = lastPlaceholder(s);
    if (end < 0) return s;
    const head = s.slice(0, end);
    const dot = head.lastIndexOf(".");
    if (dot < 0 || /[^0#?]/.test(head.slice(dot + 1))) return s;
    const decimals = head.length - dot - 1;
    return decimals <= 1 ? `${head.slice(0, dot)}${s.slice(end)}` : `${head.slice(0, -1)}${s.slice(end)}`;
  });
}
