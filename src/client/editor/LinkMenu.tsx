import type { Editor } from "@tiptap/core";
import { TextSelection, type Transaction } from "@tiptap/pm/state";
import { useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";

import { CopyIcon, EditIcon, OpenIcon, UnlinkIcon } from "../doc/toolbar/icons.tsx";
import { openDocLink, shortLink } from "../docLinks.ts";
import { copyText } from "../copyText.ts";
import { linkHref } from "./linkHref.ts";

// Buttons keep the editor's focus and caret, so the menu stays on its link.
const keepSelection = (event: MouseEvent) => event.preventDefault();


/** The link element the caret sits in, for placing the menu under it. */
function linkElementAt(editor: Editor): HTMLElement | null {
  const { view, state } = editor;
  const { node } = view.domAtPos(state.selection.from);
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest<HTMLElement>("a[href]") ?? null;
}

/**
 * The menu under a link the caret is in, for editors: the address, then open,
 * copy, edit and remove. Clicking a link places the caret in it, so a click
 * opens this menu; Cmd/Ctrl+click opens the link itself.
 */
export function LinkMenu(props: { readonly editor: Editor }) {
  const { editor } = props;
  const href = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      current.isActive("link") ? String(current.getAttributes("link").href ?? "") : null,
  });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const editingRef = useRef(false);
  editingRef.current = editing;

  // A different link (or none) ends any edit and the "Copied" note.
  useEffect(() => {
    setEditing(false);
    setCopied(false);
  }, [href]);

  const chain = () => editor.chain().focus().extendMarkRange("link");
  // Commands act on the whole link; the caret then goes back to its end.
  const collapse = ({ tr }: { tr: Transaction }) => {
    tr.setSelection(TextSelection.create(tr.doc, tr.selection.to));
    return true;
  };
  const startEdit = () => {
    setDraft(href ?? "");
    setEditing(true);
  };
  const save = () => {
    const next = linkHref(draft);
    if (next === null && draft.trim() !== "") return;
    setEditing(false);
    if (next === null) chain().unsetLink().command(collapse).run();
    else chain().setLink({ href: next }).command(collapse).run();
  };
  const cancel = () => {
    setEditing(false);
    editor.commands.focus();
  };
  const copy = () => {
    if (href) void copyText(href).then(setCopied);
  };

  const { head, tail } = shortLink(href ?? "");
  const button = (label: string, run: () => void, icon: ReactNode) => (
    <button
      type="button"
      className="toolbar-button"
      aria-label={label}
      title={label}
      onMouseDown={keepSelection}
      onClick={run}
    >
      {icon}
    </button>
  );

  return (
    <BubbleMenu
      editor={editor}
      pluginKey="linkMenu"
      className="link-menu"
      role="dialog"
      aria-label="Link"
      options={{ placement: "bottom-start", offset: 6 }}
      getReferencedVirtualElement={() => linkElementAt(editor)}
      shouldShow={({ editor: current, state }) => {
        if (editingRef.current) return true;
        return (
          current.isEditable &&
          current.isFocused &&
          state.selection.empty &&
          current.isActive("link")
        );
      }}
    >
      {editing ? (
        <form
          className="link-menu-edit"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <input
            autoFocus
            type="text"
            aria-label="Link address"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                cancel();
              }
            }}
          />
          <button type="submit" className="button small">
            Save
          </button>
        </form>
      ) : (
        <>
          <span className="link-menu-url" title={href ?? ""}>
            {head}
            <span className="link-menu-url-tail">{tail}</span>
          </span>
          <span className="toolbar-separator" aria-hidden="true" />
          {button("Open link", () => href && openDocLink(href), <OpenIcon />)}
          {button(copied ? "Copied" : "Copy link", copy, <CopyIcon />)}
          {button("Edit link", startEdit, <EditIcon />)}
          {button("Remove link", () => chain().unsetLink().command(collapse).run(), <UnlinkIcon />)}
          {copied ? (
            <span className="link-menu-note" role="status">
              Copied
            </span>
          ) : null}
        </>
      )}
    </BubbleMenu>
  );
}
