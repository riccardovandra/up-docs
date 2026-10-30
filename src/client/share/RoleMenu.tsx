import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { DOC_ROLE_LABEL, type DocRole } from "../../shared/access.ts";

const menuItems = (menu: HTMLElement | null) => [
  ...(menu?.querySelectorAll<HTMLElement>("[role^=menuitem]") ?? []),
];

/**
 * A role dropdown: a quiet "Editor ⌄" button and a menu of roles, plus an
 * optional destructive action (Remove or Leave) below a divider. Arrow keys,
 * Home/End, Enter/Space and Escape work as in a native menu.
 */
export function RoleMenu(props: {
  readonly role: DocRole;
  readonly roles: ReadonlyArray<DocRole>;
  readonly label: string;
  readonly onSelect: (role: DocRole) => void;
  readonly action?: { readonly label: string; readonly run: () => void } | undefined;
  readonly disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const items = () => menuItems(menu.current);

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
  }, [open, button, menu]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  const onMenuKeyDown = (event: KeyboardEvent) => {
    const list = items();
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
    // Keeps Escape from also closing the Share panel around this menu.
    event.preventDefault();
    event.stopPropagation();
  };

  if (props.roles.length === 0 && !props.action) {
    return <span className="share-role-static">{DOC_ROLE_LABEL[props.role]}</span>;
  }

  return (
    <div className="share-role">
      <button
        ref={button}
        type="button"
        className="share-role-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={props.label}
        disabled={props.disabled}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {DOC_ROLE_LABEL[props.role]}
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
      {open ? (
        <div
          ref={menu}
          id={menuId}
          className="share-menu"
          role="menu"
          aria-label={props.label}
          onKeyDown={onMenuKeyDown}
        >
          {props.roles.map((role) => (
            <button
              key={role}
              type="button"
              role="menuitemradio"
              aria-checked={role === props.role}
              tabIndex={-1}
              onClick={() => {
                close();
                if (role !== props.role) props.onSelect(role);
              }}
            >
              {DOC_ROLE_LABEL[role]}
              {role === props.role ? (
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                  <path d="M3 8.5l3.2 3L13 5" fill="none" stroke="currentColor" strokeWidth="1.6" />
                </svg>
              ) : null}
            </button>
          ))}
          {props.action ? (
            <>
              {props.roles.length > 0 ? (
                <div className="share-menu-divider" role="separator" />
              ) : null}
              <button
                type="button"
                role="menuitem"
                className="danger"
                tabIndex={-1}
                onClick={() => {
                  close();
                  props.action?.run();
                }}
              >
                {props.action.label}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
