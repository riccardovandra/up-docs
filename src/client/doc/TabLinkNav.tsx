import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import type { Tab } from "../../shared/protocol.ts";
import { TAB_LINK_ATTRIBUTE } from "../editor/tabLinks.ts";
import { docPath, navigate } from "../router.ts";

const MAX_HEADINGS = 6;

/** The first headings of a tab's markdown (levels 1 to 3), outside code fences. */
export function tabHeadings(markdown: string): ReadonlyArray<string> {
  const headings: string[] = [];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const match = fenced ? null : /^#{1,3}\s+(.+?)\s*#*\s*$/.exec(line);
    if (match?.[1]) headings.push(match[1]);
    if (headings.length === MAX_HEADINGS) break;
  }
  return headings;
}

export function wordCount(markdown: string): number {
  return markdown.split(/\s+/).filter((word) => /\w/.test(word)).length;
}

interface Hover {
  readonly tabId: string;
  readonly left: number;
  readonly top: number;
  readonly above: boolean;
}

/**
 * Hover cards for tab-link chips, and a "Back to" pill after following one.
 * Reads the chips the editor's TabLinks decorations mark inside `container`.
 */
export function TabLinkNav(props: {
  readonly container: HTMLElement | null;
  readonly docId: string;
  readonly activeTabId: string | null;
  readonly tabs: ReadonlyMap<string, Tab>;
}) {
  const { container, activeTabId } = props;
  const [hover, setHover] = useState<Hover | null>(null);
  const [jump, setJump] = useState<{ readonly from: string; readonly to: string } | null>(null);

  useEffect(() => {
    if (!container) return;
    const chipOf = (target: EventTarget | null) =>
      target instanceof Element ? target.closest<HTMLElement>(`[${TAB_LINK_ATTRIBUTE}]`) : null;
    const onOver = (event: MouseEvent) => {
      const chip = chipOf(event.target);
      const tabId = chip?.getAttribute(TAB_LINK_ATTRIBUTE);
      if (!chip || !tabId) return;
      const rect = chip.getBoundingClientRect();
      const above = rect.bottom + 240 > window.innerHeight;
      setHover({
        tabId,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 328)),
        top: above ? rect.top - 8 : rect.bottom + 8,
        above,
      });
    };
    const onOut = (event: MouseEvent) => {
      if (chipOf(event.target) && !chipOf(event.relatedTarget)) setHover(null);
    };
    // Capture runs before the editor follows the link, while the old tab is still active.
    const onClick = (event: MouseEvent) => {
      setHover(null);
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
        return;
      }
      const to = chipOf(event.target)?.getAttribute(TAB_LINK_ATTRIBUTE);
      if (to && activeTabId && to !== activeTabId) setJump({ from: activeTabId, to });
    };
    container.addEventListener("mouseover", onOver);
    container.addEventListener("mouseout", onOut);
    container.addEventListener("click", onClick, true);
    return () => {
      container.removeEventListener("mouseover", onOver);
      container.removeEventListener("mouseout", onOut);
      container.removeEventListener("click", onClick, true);
    };
  }, [container, activeTabId]);

  // A card left behind by scrolling would point at the wrong place.
  useEffect(() => {
    if (!hover) return;
    const close = () => setHover(null);
    window.addEventListener("scroll", close, true);
    return () => window.removeEventListener("scroll", close, true);
  }, [hover]);

  const from = jump && jump.to === activeTabId ? props.tabs.get(jump.from) : undefined;
  const target = hover ? props.tabs.get(hover.tabId) : undefined;

  return (
    <>
      {from ? (
        <button
          type="button"
          className="tab-link-back"
          onClick={() => {
            setJump(null);
            navigate(docPath(props.docId, from.id));
          }}
        >
          <span aria-hidden="true">←</span> Back to {from.title || "Untitled"}
        </button>
      ) : null}
      {hover
        ? createPortal(
            <div
              className="tab-link-card"
              role="tooltip"
              style={{
                left: hover.left,
                top: hover.top,
                transform: hover.above ? "translateY(-100%)" : undefined,
              }}
            >
              {target ? (
                <>
                  <div className="tab-link-card-title">{target.title || "Untitled"}</div>
                  <div className="tab-link-card-meta">
                    {wordCount(target.markdown).toLocaleString()} words
                  </div>
                  {tabHeadings(target.markdown).length > 0 ? (
                    <ul>
                      {tabHeadings(target.markdown).map((heading, index) => (
                        <li key={index}>{heading}</li>
                      ))}
                    </ul>
                  ) : null}
                  <div className="tab-link-card-hint">
                    Click to open · ⌘/Ctrl+click opens a new window
                  </div>
                </>
              ) : (
                <div className="tab-link-card-meta">This tab no longer exists.</div>
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
