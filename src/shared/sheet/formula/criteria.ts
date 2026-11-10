// Criteria for SUMIF, COUNTIF, AVERAGEIF and their -IFS forms: a number or
// boolean matches equal values; a string may start with = <> < > <= >= and
// text operands support the wildcards * and ? (~ escapes them).

import { parseNumberText } from "../input.ts";
import type { Scalar } from "../types.ts";
import { isError } from "./values.ts";

export type Criterion = (v: Scalar) => boolean;

/** Regex for a wildcard pattern, whole-string and case-insensitive. */
export function wildcardRegex(pattern: string): RegExp {
  let src = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (ch === "~" && i + 1 < pattern.length && /[*?~]/.test(pattern[i + 1] as string)) {
      src += `\\${pattern[++i]}`;
    } else if (ch === "*") src += "[\\s\\S]*";
    else if (ch === "?") src += "[\\s\\S]";
    else src += ch.replace(/[.+^${}()|[\]\\/-]/g, "\\$&");
  }
  return new RegExp(`^${src}$`, "i");
}

function isBlank(v: Scalar): boolean {
  return v === null || v === "";
}

export function makeCriterion(crit: Scalar): Criterion {
  if (isError(crit)) return (v) => isError(v) && v.error === crit.error;
  if (crit === null) return isBlank;
  if (typeof crit === "number") return (v) => typeof v === "number" && v === crit;
  if (typeof crit === "boolean") return (v) => v === crit;
  const m = /^(<=|>=|<>|<|>|=)?([\s\S]*)$/.exec(crit) as RegExpExecArray;
  const op = m[1] ?? "";
  const operand = m[2] as string;
  const asNumber = operand.trim() === "" ? null : parseNumberText(operand);
  if (asNumber) {
    const n = asNumber.value;
    switch (op) {
      case "<>":
        return (v) => !(typeof v === "number" && v === n);
      case "<":
        return (v) => typeof v === "number" && v < n;
      case ">":
        return (v) => typeof v === "number" && v > n;
      case "<=":
        return (v) => typeof v === "number" && v <= n;
      case ">=":
        return (v) => typeof v === "number" && v >= n;
      default:
        return (v) =>
          (typeof v === "number" && v === n) ||
          (typeof v === "string" && v.trim() !== "" && parseNumberText(v)?.value === n);
    }
  }
  if (/^(true|false)$/i.test(operand)) {
    const b = operand.toLowerCase() === "true";
    if (op === "<>") return (v) => v !== b;
    if (op === "" || op === "=") return (v) => v === b;
  }
  if (op === "" || op === "=") {
    if (operand === "") return isBlank;
    const re = wildcardRegex(operand);
    return (v) => typeof v === "string" && re.test(v);
  }
  if (op === "<>") {
    if (operand === "") return (v) => !isBlank(v);
    const re = wildcardRegex(operand);
    return (v) => !(typeof v === "string" && re.test(v));
  }
  const text = operand.toLowerCase();
  return (v) => {
    if (typeof v !== "string") return false;
    const t = v.toLowerCase();
    switch (op) {
      case "<":
        return t < text;
      case ">":
        return t > text;
      case "<=":
        return t <= text;
      default:
        return t >= text;
    }
  };
}
