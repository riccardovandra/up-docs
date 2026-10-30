import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { useState, type MouseEvent, type ReactNode } from "react";

import { ChevronDown, CodeIcon, CommentIcon, LinkIcon, ListIcon } from "../doc/toolbar/icons.tsx";

type TextStyle = "paragraph" | 1 | 2 | 3;
type ListKind = "bulletList" | "orderedList" | "taskList";

const TEXT_STYLES: ReadonlyArray<{ readonly value: TextStyle; readonly label: string }> = [
  { value: "paragraph", label: "Text" },
  { value: 1, label: "Heading 1" },
  { value: 2, label: "Heading 2" },
  { value: 3, label: "Heading 3" },
];

const LISTS: ReadonlyArray<{ readonly value: ListKind; readonly label: string }> = [
  { value: "bulletList", label: "Bulleted list" },
  { value: "orderedList", label: "Numbered list" },
  { value: "taskList", label: "Checklist" },
];

// Every press keeps the editor's focus and selection, so the menu stays up
// and the command applies to what was selected.
const keepSelection = (event: MouseEvent) => event.preventDefault();

/** Links typed without a scheme open as https; anything but web and mail links is refused. */
function linkHref(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  const href = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  return /^(https?|mailto):/i.test(href) ? href : null;
}

/**
 * The menu over a text selection: Comment first, then (for editors) text
 * style, marks, lists and link. Commenters get Comment alone. Code blocks,
 * diagrams and rich tables have their own comment paths, so it stays away
 * from them.
 */
export function SelectionToolbar(props: {
  readonly editor: Editor;
  readonly canEdit: boolean;
  readonly onComment: () => void;
}) {
  const { editor, canEdit } = props;
  // A dropdown belongs to the selection it was opened on and closes when that changes.
  const [openMenu, setOpenMenu] = useState<{
    readonly id: "style" | "list";
    readonly at: string;
  } | null>(null);
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      from: current.state.selection.from,
      to: current.state.selection.to,
      bold: current.isActive("bold"),
      italic: current.isActive("italic"),
      underline: current.isActive("underline"),
      strike: current.isActive("strike"),
      code: current.isActive("code"),
      link: current.isActive("link"),
      style: ([1, 2, 3] as const).find((level) => current.isActive("heading", { level })) ?? null,
      list: LISTS.find((list) => current.isActive(list.value))?.value ?? null,
    }),
  });
  const at = `${state.from}:${state.to}`;
  const menu = openMenu?.at === at ? openMenu.id : null;
  const setMenu = (id: "style" | "list" | null) => setOpenMenu(id === null ? null : { id, at });

  const chain = () => editor.chain().focus();
  const setStyle = (style: TextStyle) =>
    (style === "paragraph" ? chain().setParagraph() : chain().setHeading({ level: style })).run();
  const toggleList = (list: ListKind) => {
    const run = chain();
    (list === "bulletList"
      ? run.toggleBulletList()
      : list === "orderedList"
        ? run.toggleOrderedList()
        : run.toggleTaskList()
    ).run();
  };
  const toggleLink = () => {
    if (state.link) {
      chain().extendMarkRange("link").unsetLink().run();
      return;
    }
    const href = linkHref(window.prompt("Link address") ?? "");
    if (href) chain().extendMarkRange("link").setLink({ href }).run();
  };

  const mark = (label: string, active: boolean, run: () => void, content: ReactNode) => (
    <button
      type="button"
      className="toolbar-button"
      aria-label={label}
      aria-pressed={active}
      onMouseDown={keepSelection}
      onClick={run}
    >
      {content}
    </button>
  );

  const dropdown = (
    id: "style" | "list",
    label: string,
    trigger: ReactNode,
    items: ReadonlyArray<{ readonly label: string; readonly checked: boolean; run: () => void }>,
  ) => (
    <div className="popover">
      <button
        type="button"
        className="toolbar-button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={menu === id}
        onMouseDown={keepSelection}
        onClick={() => setMenu(menu === id ? null : id)}
      >
        {trigger}
        <ChevronDown />
      </button>
      {menu === id ? (
        <div className="popover-panel selection-toolbar-menu" role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitemradio"
              aria-checked={item.checked}
              className="menu-item"
              onMouseDown={keepSelection}
              onClick={() => {
                setMenu(null);
                item.run();
              }}
            >
              <span className="menu-item-check" aria-hidden="true">
                {item.checked ? "✓" : ""}
              </span>
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );

  return (
    <BubbleMenu
      editor={editor}
      className="selection-toolbar"
      role="toolbar"
      aria-label="Selection"
      options={{ placement: "top-start" }}
      shouldShow={({ editor: current, view, state: editorState }) => {
        const { selection } = editorState;
        if (selection.empty || !(selection instanceof TextSelection)) return false;
        if (selection.$from.parent.type.spec.code || selection.$to.parent.type.spec.code) {
          return false;
        }
        // A read-only view never takes focus, so the page selection says whether it is live.
        return current.isEditable
          ? current.isFocused
          : view.dom.contains(window.getSelection()?.anchorNode ?? null);
      }}
    >
      <button
        type="button"
        className="toolbar-button"
        aria-label="Comment (Cmd+Option+M)"
        onMouseDown={keepSelection}
        onClick={props.onComment}
      >
        <CommentIcon />
      </button>
      {canEdit ? (
        <>
          <span className="toolbar-separator" aria-hidden="true" />
          {dropdown(
            "style",
            "Text style",
            <span className="selection-toolbar-glyph">Aa</span>,
            TEXT_STYLES.map((style) => ({
              label: style.label,
              checked: (state.style ?? "paragraph") === style.value,
              run: () => setStyle(style.value),
            })),
          )}
          <span className="toolbar-separator" aria-hidden="true" />
          {mark(
            "Bold",
            state.bold,
            () => chain().toggleBold().run(),
            <b className="selection-toolbar-glyph">B</b>,
          )}
          {mark(
            "Italic",
            state.italic,
            () => chain().toggleItalic().run(),
            <i className="selection-toolbar-glyph">I</i>,
          )}
          {mark(
            "Underline",
            state.underline,
            () => chain().toggleUnderline().run(),
            <u className="selection-toolbar-glyph">U</u>,
          )}
          {mark(
            "Strikethrough",
            state.strike,
            () => chain().toggleStrike().run(),
            <s className="selection-toolbar-glyph">S</s>,
          )}
          {mark("Inline code", state.code, () => chain().toggleCode().run(), <CodeIcon />)}
          <span className="toolbar-separator" aria-hidden="true" />
          {dropdown(
            "list",
            "List",
            <ListIcon />,
            LISTS.map((list) => ({
              label: list.label,
              checked: state.list === list.value,
              run: () => toggleList(list.value),
            })),
          )}
          <span className="toolbar-separator" aria-hidden="true" />
          {mark(state.link ? "Remove link" : "Link", state.link, toggleLink, <LinkIcon />)}
        </>
      ) : null}
    </BubbleMenu>
  );
}
