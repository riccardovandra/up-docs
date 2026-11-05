import { Extension } from "@tiptap/core";
import { Plugin, TextSelection } from "@tiptap/pm/state";

/**
 * The link a paste holds when it is one web or mail address and nothing else,
 * ignoring the spaces and line breaks copying often adds; null otherwise.
 * `www.` addresses open as https.
 */
export function pastedLinkHref(text: string): string | null {
  const value = text.trim();
  if (value === "" || /\s/.test(value)) return null;
  const href = /^www\./i.test(value) ? `https://${value}` : value;
  if (!/^(https?:\/\/[^/?#]+|mailto:[^@\s]+@)/i.test(href)) return null;
  return URL.canParse(href) ? href : null;
}

/**
 * Pasting a link over selected text links that text rather than replacing it.
 * Runs before Tiptap's own handler, which needs the paste to be the bare
 * address exactly. Code is left alone, as is a selection spanning blocks.
 */
export const LinkPaste = Extension.create({
  name: "linkPaste",
  priority: 1000,
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        props: {
          handlePaste: (view, event) => {
            const { selection } = view.state;
            if (!view.editable || selection.empty || !(selection instanceof TextSelection)) {
              return false;
            }
            const { $from, $to } = selection;
            if (!$from.sameParent($to) || $from.parent.type.spec.code) return false;
            const href = pastedLinkHref(event.clipboardData?.getData("text/plain") ?? "");
            if (href === null) return false;
            return editor.chain().focus().setLink({ href }).run();
          },
        },
      }),
    ];
  },
});
