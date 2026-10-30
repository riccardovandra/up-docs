import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { CheckIcon } from "./icons.tsx";

const menuItems = (menu: HTMLElement | null) => [
  ...(menu?.querySelectorAll<HTMLElement>("[role^=menuitem]:not(:disabled)") ?? []),
];

/**
 * A button that opens a popover menu. Arrow keys, Home/End and Escape work as
 * in a native menu; clicking outside closes it. `children` receives `close`.
 */
export function Menu(props: {
  readonly label: string;
  readonly trigger: ReactNode;
  readonly triggerClassName?: string;
  readonly align?: "start" | "end";
  readonly children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const list = menuItems(menu.current);
    (list.find((item) => item.getAttribute("aria-checked") === "true") ?? list[0])?.focus();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const list = menuItems(menu.current);
    const index = list.indexOf(document.activeElement as HTMLElement);
    const focusAt = (next: number) => list[(next + list.length) % list.length]?.focus();
    switch (event.key) {
      case "ArrowDown":
        focusAt(index + 1);
        break;
      case "ArrowUp":
        focusAt(index - 1);
        break;
      case "Home":
        focusAt(0);
        break;
      case "End":
        focusAt(list.length - 1);
        break;
      case "Escape":
        close();
        break;
      case "Tab":
        setOpen(false);
        return;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div className="home-menu-wrap">
      <button
        ref={button}
        type="button"
        className={props.triggerClassName ?? "home-icon-button"}
        aria-label={props.label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        {props.trigger}
      </button>
      {open ? (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label={props.label}
          className={`home-menu ${props.align === "start" ? "align-start" : "align-end"}`}
          onKeyDown={onKeyDown}
          onClick={(event) => event.stopPropagation()}
        >
          {props.children(close)}
        </div>
      ) : null}
    </div>
  );
}

export function MenuItem(props: {
  readonly children: ReactNode;
  readonly onSelect: () => void;
  /** Set for radio and checkbox items; shows a check when true. */
  readonly checked?: boolean;
  readonly kind?: "radio" | "checkbox";
  readonly icon?: ReactNode;
  readonly disabled?: boolean;
  readonly danger?: boolean;
}) {
  const role =
    props.kind === "radio"
      ? "menuitemradio"
      : props.kind === "checkbox"
        ? "menuitemcheckbox"
        : "menuitem";
  return (
    <button
      type="button"
      role={role}
      tabIndex={-1}
      disabled={props.disabled}
      aria-checked={props.kind ? props.checked === true : undefined}
      className={props.danger ? "home-menu-item danger" : "home-menu-item"}
      onClick={props.onSelect}
    >
      {props.icon ? <span className="home-menu-item-icon">{props.icon}</span> : null}
      <span className="home-menu-item-label">{props.children}</span>
      {props.kind ? (
        <span className="home-menu-item-check">
          {props.checked ? <CheckIcon size={15} /> : null}
        </span>
      ) : null}
    </button>
  );
}

export const MenuLabel = (props: { readonly children: ReactNode }) => (
  <div className="home-menu-label">{props.children}</div>
);

export const MenuSeparator = () => <div role="separator" className="home-menu-separator" />;
