import { useLayoutEffect, useRef, type KeyboardEvent, type RefObject } from "react";

import { formulaRefSpans } from "./formulaRefs.ts";

/**
 * A one-line input that colours the references of a formula as it is typed.
 * The text is drawn by a mirror behind a transparent input, so the caret,
 * selection and IME all stay the browser's own.
 */
export function FormulaInput(props: {
  readonly value: string;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly className?: string;
  readonly ariaLabel: string;
  readonly placeholder?: string;
  readonly onChange: (value: string) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  readonly onFocus?: () => void;
  readonly onBlur?: () => void;
}) {
  const mirror = useRef<HTMLDivElement>(null);
  const formula = props.value.startsWith("=");

  const sync = () => {
    const input = props.inputRef.current;
    if (input && mirror.current) mirror.current.scrollLeft = input.scrollLeft;
  };
  useLayoutEffect(sync);

  const parts: Array<{ text: string; color?: string }> = [];
  if (formula) {
    let at = 0;
    for (const span of formulaRefSpans(props.value)) {
      if (span.start > at) parts.push({ text: props.value.slice(at, span.start) });
      parts.push({ text: props.value.slice(span.start, span.end), color: span.color });
      at = span.end;
    }
    if (at < props.value.length) parts.push({ text: props.value.slice(at) });
  }

  return (
    <div className={`formula-input${formula ? " is-formula" : ""} ${props.className ?? ""}`}>
      {formula ? (
        <div className="formula-mirror" ref={mirror} aria-hidden="true">
          {parts.map((part, index) =>
            part.color ? (
              <span key={index} style={{ color: part.color }}>
                {part.text}
              </span>
            ) : (
              <span key={index}>{part.text}</span>
            ),
          )}
        </div>
      ) : null}
      <input
        ref={props.inputRef}
        className="formula-field"
        aria-label={props.ariaLabel}
        placeholder={props.placeholder}
        spellCheck={false}
        autoComplete="off"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={props.onKeyDown}
        onKeyUp={sync}
        onSelect={sync}
        onScroll={sync}
        onFocus={props.onFocus}
        onBlur={props.onBlur}
      />
    </div>
  );
}
