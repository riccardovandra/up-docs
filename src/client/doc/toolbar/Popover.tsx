import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * A trigger button with a panel below it. Closes on Escape, on a press
 * outside, and when an enabled menu item is clicked (unless it is marked
 * `data-keep-open`). Presses are only observed, never stopped, so other
 * listeners such as diagram picking still see them.
 */
export function Popover(props: {
  readonly label: string;
  readonly trigger: ReactNode;
  readonly triggerClassName?: string;
  readonly align?: "start" | "end";
  readonly panelClassName?: string;
  readonly disabled?: boolean;
  readonly onClosed?: () => void;
  readonly children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const onClosed = useRef(props.onClosed);
  useLayoutEffect(() => {
    onClosed.current = props.onClosed;
  });
  useEffect(() => {
    if (!open) onClosed.current?.();
  }, [open]);
  const root = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  return (
    <div className="popover" ref={root}>
      <button
        type="button"
        className={props.triggerClassName ?? "toolbar-button"}
        aria-label={props.label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={props.disabled}
        onClick={() => setOpen((value) => !value)}
      >
        {props.trigger}
      </button>
      {open ? (
        <div
          className={`popover-panel ${props.align === "end" ? "align-end" : ""} ${props.panelClassName ?? ""}`}
          role="menu"
          onClick={(event) => {
            const item = (event.target as HTMLElement).closest("button:not(:disabled)");
            if (item && !item.closest("[data-keep-open]")) close();
          }}
        >
          {props.children(close)}
        </div>
      ) : null}
    </div>
  );
}

export function MenuItem(props: {
  readonly label: ReactNode;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  readonly danger?: boolean;
  readonly checked?: boolean;
  readonly keepOpen?: boolean;
}) {
  return (
    <button
      type="button"
      role={props.checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={props.checked}
      className={props.danger ? "menu-item danger" : "menu-item"}
      disabled={props.disabled}
      data-keep-open={props.keepOpen ? "" : undefined}
      onClick={props.onSelect}
    >
      <span className="menu-item-check" aria-hidden="true">
        {props.checked ? "✓" : ""}
      </span>
      {props.label}
    </button>
  );
}

export const MenuSeparator = () => <div className="menu-separator" role="separator" />;

export const MenuLabel = (props: { readonly children: ReactNode }) => (
  <div className="menu-label">{props.children}</div>
);

/** Inline text input that commits on Enter or blur and cancels on Escape (committing ""). */
export function InlineRename(props: {
  readonly value: string;
  readonly label: string;
  readonly className?: string;
  readonly onDone: (value: string) => void;
}) {
  const done = useRef(false);
  const onDone = useRef(props.onDone);
  useLayoutEffect(() => {
    onDone.current = props.onDone;
  });
  const finish = (value: string) => {
    if (done.current) return;
    done.current = true;
    onDone.current(value.trim());
  };
  return (
    <input
      className={props.className ?? "inline-rename"}
      aria-label={props.label}
      defaultValue={props.value}
      maxLength={200}
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onBlur={(event) => finish(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") finish(event.currentTarget.value);
        if (event.key === "Escape") finish("");
      }}
    />
  );
}
