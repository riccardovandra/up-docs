import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";

import { followClickedLink, sameDocTabId } from "../docLinks.ts";

/**
 * Opens links on click for viewers. In an editable view a plain click places
 * the caret in the link, which opens the link menu; Cmd/Ctrl+click still opens
 * it in a new tab. A link to another tab of the same doc opens in place on a
 * plain click for editors too; arrow keys or a drag still reach its menu. StarterKit's own `openOnClick` stays off: it skips
 * read-only editors and cannot route a link inside the app. Rich tables call
 * `followClickedLink` first, from their own listener.
 */
export const LinkClick = Extension.create({
  name: "linkClick",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            click: (view, event) => {
              if (view.editable && !event.metaKey && !event.ctrlKey && !isTabLink(event)) {
                return false;
              }
              return followClickedLink(event);
            },
          },
        },
      }),
    ];
  },
});

function isTabLink(event: MouseEvent): boolean {
  const anchor = (event.target as Element | null)?.closest?.("a[href]");
  return anchor ? sameDocTabId(anchor.getAttribute("href") ?? "", window.location) !== null : false;
}
