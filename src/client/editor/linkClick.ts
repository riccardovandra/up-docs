import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";

import { followClickedLink } from "../docLinks.ts";

/**
 * Opens links on click, for editors and viewers alike. StarterKit's own
 * `openOnClick` stays off: it skips read-only editors and cannot route a link
 * inside the app. Rich tables call this first, from their own listener.
 */
export const LinkClick = Extension.create({
  name: "linkClick",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: { handleDOMEvents: { click: (_view, event) => followClickedLink(event) } },
      }),
    ];
  },
});
