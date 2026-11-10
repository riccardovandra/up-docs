import { useEffect, useRef, useState, type ReactNode } from "react";

import type { CellFormat, FormatPatch, HorizontalAlignment } from "../../shared/sheet/types.ts";
import { DEFAULT_FONT_POINTS } from "./layout.ts";

const FONT_SIZES = [8, 9, 10, 11, 12, 14, 18, 24, 36];

/** Soft fills for header rows first, then stronger ones. */
const FILLS = [
  "#fce8e6", "#fef7e0", "#e6f4ea", "#e8f0fe", "#f3e8fd", "#fde7f3", "#e4f7fb", "#f1f3f4",
  "#f28b82", "#fdd663", "#81c995", "#8ab4f8", "#c58af9", "#ff8bcb", "#78d9ec", "#bdc1c6",
];
const INKS = [
  "#1f1f1f", "#5f6368", "#c5221f", "#e37400", "#188038", "#1a73e8", "#9334e6", "#d01884",
];

export const NUMBER_FORMATS: ReadonlyArray<{ readonly label: string; readonly pattern: string | null; readonly example: string }> = [
  { label: "Automatic", pattern: null, example: "1000.12" },
  { label: "Number", pattern: "#,##0.00", example: "1,000.12" },
  { label: "Percent", pattern: "0.00%", example: "10.12%" },
  { label: "Currency", pattern: "$#,##0.00", example: "$1,000.12" },
  { label: "Date", pattern: "yyyy-mm-dd", example: "2026-03-15" },
];

function Popover(props: {
  readonly label: string;
  readonly trigger: ReactNode;
  readonly className?: string;
  readonly children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState<{ left: number; bottom: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(null);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <div className="sheet-tool-pop" ref={root}>
      <button
        type="button"
        className={`sheet-tool ${props.className ?? ""}`}
        aria-label={props.label}
        title={props.label}
        aria-haspopup="true"
        aria-expanded={open !== null}
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          // Fixed to the window: the toolbar scrolls sideways on a phone and would clip it.
          const box = event.currentTarget.getBoundingClientRect();
          const left = Math.max(8, Math.min(box.left, window.innerWidth - 200));
          setOpen((value) => (value ? null : { left, bottom: window.innerHeight - box.top + 8 }));
        }}
      >
        {props.trigger}
      </button>
      {open ? (
        <div className="sheet-tool-menu" style={{ left: open.left, bottom: open.bottom }}>
          {props.children(() => setOpen(null))}
        </div>
      ) : null}
    </div>
  );
}

function Swatches(props: {
  readonly colors: ReadonlyArray<string>;
  readonly none: string;
  readonly onPick: (color: string | null) => void;
}) {
  return (
    <>
      <button type="button" className="sheet-swatch-none" onClick={() => props.onPick(null)}>
        {props.none}
      </button>
      <div className="sheet-swatches">
        {props.colors.map((color) => (
          <button
            key={color}
            type="button"
            className="sheet-swatch"
            style={{ background: color }}
            aria-label={color}
            title={color}
            onClick={() => props.onPick(color)}
          />
        ))}
      </div>
    </>
  );
}

const Svg = (props: { readonly children: ReactNode }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {props.children}
  </svg>
);

const ALIGN_ICONS: Record<HorizontalAlignment, ReactNode> = {
  left: <Svg><path d="M4 6h16M4 12h10M4 18h14" /></Svg>,
  center: <Svg><path d="M4 6h16M7 12h10M5 18h14" /></Svg>,
  right: <Svg><path d="M4 6h16M10 12h10M6 18h14" /></Svg>,
};

/**
 * The floating toolbar: font size, bold, italic, underline, alignment, text
 * and fill colour, number format and decimals. It shows the active cell's
 * format; every button formats the whole (bounded) selection.
 */
export function Toolbar(props: {
  readonly format: CellFormat | undefined;
  readonly onFormat: (patch: FormatPatch) => void;
  readonly onNumberFormat: (pattern: string | null) => void;
  readonly onDecimals: (direction: -1 | 1) => void;
}) {
  const font = props.format?.font;
  const align = props.format?.alignment?.horizontal ?? "left";
  const size = font?.size ?? DEFAULT_FONT_POINTS;
  const keep = (event: { preventDefault: () => void }) => event.preventDefault();
  const toggle = (key: "bold" | "italic" | "underline") => props.onFormat({ font: { [key]: !font?.[key] } });
  const nextAlign: Record<HorizontalAlignment, HorizontalAlignment> = { left: "center", center: "right", right: "left" };

  return (
    <div className="sheet-toolbar" role="toolbar" aria-label="Format">
      <Popover label="Font size" trigger={<span className="sheet-tool-size">{size}</span>}>
        {(close) =>
          FONT_SIZES.map((points) => (
            <button
              key={points}
              type="button"
              className={`sheet-menu-item${points === size ? " checked" : ""}`}
              onClick={() => {
                props.onFormat({ font: { size: points === DEFAULT_FONT_POINTS ? null : points } });
                close();
              }}
            >
              {points}
            </button>
          ))
        }
      </Popover>
      <span className="sheet-tool-sep" />
      <button type="button" className="sheet-tool" aria-label="Bold" title="Bold (Cmd/Ctrl+B)" aria-pressed={font?.bold === true} onMouseDown={keep} onClick={() => toggle("bold")}>
        <b>B</b>
      </button>
      <button type="button" className="sheet-tool" aria-label="Italic" title="Italic (Cmd/Ctrl+I)" aria-pressed={font?.italic === true} onMouseDown={keep} onClick={() => toggle("italic")}>
        <i>I</i>
      </button>
      <button type="button" className="sheet-tool" aria-label="Underline" title="Underline (Cmd/Ctrl+U)" aria-pressed={font?.underline === true} onMouseDown={keep} onClick={() => toggle("underline")}>
        <u>U</u>
      </button>
      <button
        type="button"
        className="sheet-tool"
        aria-label={`Align ${align}`}
        title="Horizontal align"
        onMouseDown={keep}
        onClick={() => props.onFormat({ alignment: { horizontal: nextAlign[align] } })}
      >
        {ALIGN_ICONS[align]}
      </button>
      <span className="sheet-tool-sep" />
      <Popover
        label="Text colour"
        trigger={
          <span className="sheet-tool-color">
            A<span className="sheet-tool-bar" style={{ background: font?.color ?? "currentColor" }} />
          </span>
        }
      >
        {(close) => (
          <Swatches
            colors={INKS}
            none="Automatic"
            onPick={(color) => {
              props.onFormat({ font: { color } });
              close();
            }}
          />
        )}
      </Popover>
      <Popover
        label="Fill colour"
        trigger={
          <span className="sheet-tool-color">
            <Svg><path d="m5 12 7-7 7 7-7 7z" /><path d="M19 16s2 2.2 2 3.5a2 2 0 0 1-4 0c0-1.3 2-3.5 2-3.5z" /></Svg>
            <span className="sheet-tool-bar" style={{ background: props.format?.fillColor ?? "transparent" }} />
          </span>
        }
      >
        {(close) => (
          <Swatches
            colors={FILLS}
            none="No fill"
            onPick={(color) => {
              props.onFormat({ fillColor: color });
              close();
            }}
          />
        )}
      </Popover>
      <span className="sheet-tool-sep" />
      <Popover label="Number format" trigger={<span className="sheet-tool-text">123 ▾</span>}>
        {(close) =>
          NUMBER_FORMATS.map((item) => (
            <button
              key={item.label}
              type="button"
              className={`sheet-menu-item${(props.format?.numberFormat?.pattern ?? null) === item.pattern ? " checked" : ""}`}
              onClick={() => {
                props.onNumberFormat(item.pattern);
                close();
              }}
            >
              <span>{item.label}</span>
              <span className="sheet-menu-hint">{item.example}</span>
            </button>
          ))
        }
      </Popover>
      <button type="button" className="sheet-tool" aria-label="Decrease decimal places" title="Decrease decimal places" onMouseDown={keep} onClick={() => props.onDecimals(-1)}>
        <span className="sheet-tool-text">.0←</span>
      </button>
      <button type="button" className="sheet-tool" aria-label="Increase decimal places" title="Increase decimal places" onMouseDown={keep} onClick={() => props.onDecimals(1)}>
        <span className="sheet-tool-text">.00→</span>
      </button>
    </div>
  );
}
