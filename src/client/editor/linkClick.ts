import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";

import { followClickedLink } from "../docLinks.ts";

/**
 * Opens links on click for viewers. In an editable view a plain click places
 * the caret in the link, which opens the link menu; Cmd/Ctrl+click still opens
 * it in a new tab. StarterKit's own `openOnClick` stays off: it skips
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
              if (view.editable && !event.metaKey && !event.ctrlKey) return false;
              return followClickedLink(event);
            },
          },
        },
      }),
    ];
  },
});
