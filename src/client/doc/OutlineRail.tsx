import type { Editor } from "@tiptap/core";
import { useState } from "react";

import { revealPos } from "../editor/headingFold.ts";
import "./outline.css";
import { headingElement, headingPos, useActiveHeading, useOutline } from "./useOutline.ts";

/**
 * Right rail for the live outline of the active tab: H1–H3 headings,
 * indented by level, with the section being read highlighted. In narrow
 * layouts it collapses behind an "Outline" toggle.
 */
export function OutlineRail(props: { readonly editor: Editor | null }) {
  const { editor } = props;
  const outline = useOutline(editor);
  const [active, setActive] = useActiveHeading(editor, outline);
  const [open, setOpen] = useState(false);

  const jump = (key: string) => {
    const pos = editor ? headingPos(editor, key) : null;
    if (editor && pos !== null) revealPos(editor.view, pos);
    const element = editor ? headingElement(editor, key) : null;
    if (!element) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.scrollIntoView({ block: "start", behavior: reduceMotion ? "auto" : "smooth" });
    setActive(key);
    setOpen(false);
  };

  return (
    <nav className={open ? "outline-rail open" : "outline-rail"} aria-label="Outline">
      <button
        type="button"
        className="outline-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        Outline
      </button>
      <div className="outline-panel">
        <p className="outline-label">Outline</p>
        {outline.headings.length === 0 ? (
          <p className="outline-empty">Headings in this tab appear here.</p>
        ) : (
          <ul>
            {outline.headings.map((heading) => (
              <li
                key={heading.key}
                className={outline.fresh.has(heading.key) ? "outline-item-new" : undefined}
              >
                <button
                  type="button"
                  className={
                    heading.key === active
                      ? `outline-item level-${heading.level} active`
                      : `outline-item level-${heading.level}`
                  }
                  aria-current={heading.key === active ? "location" : undefined}
                  onClick={() => jump(heading.key)}
                >
                  {heading.text}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </nav>
  );
}
