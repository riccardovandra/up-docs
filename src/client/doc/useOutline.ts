import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { EXTERNAL_CONTENT_META } from "../editor/TabEditor.tsx";
import {
  type OutlineHeading,
  activeAfter,
  extractHeadings,
  newHeadingKeys,
  sameOutline,
} from "./outline.ts";
import { flashHeadings, registerOutlineFlash } from "./outlineFlash.ts";

// Coalesces keystrokes; the outline lags typing by at most this much.
const RECOMPUTE_MS = 150;

export interface OutlineState {
  readonly headings: ReadonlyArray<OutlineHeading>;
  /** Headings that arrived with the latest remote change. */
  readonly fresh: ReadonlySet<string>;
}

const EMPTY_KEYS: ReadonlySet<string> = new Set();
const EMPTY_STATE: OutlineState = { headings: [], fresh: EMPTY_KEYS };
const noSubscription = () => () => {};
const emptySnapshot = () => EMPTY_STATE;

function createOutlineStore(editor: Editor) {
  let snapshot: OutlineState = { headings: extractHeadings(editor.state.doc), fresh: EMPTY_KEYS };

  const subscribe = (notify: () => void) => {
    const unregisterFlash = registerOutlineFlash(editor);
    let remotePending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const recompute = () => {
      timer = undefined;
      if (editor.isDestroyed) return;
      const current = snapshot.headings;
      const next = extractHeadings(editor.state.doc);
      const remote = remotePending;
      remotePending = false;
      const changed = !sameOutline(current, next);
      // A remote write replaces the whole doc, so heading DOM may be new even
      // when the outline reads the same; a new snapshot makes observers rebind.
      if (!changed && !remote) return;
      const added = remote && changed ? new Set(newHeadingKeys(current, next)) : EMPTY_KEYS;
      snapshot = { headings: next, fresh: changed ? added : snapshot.fresh };
      notify();
      flashHeadings(
        editor,
        next.filter((heading) => added.has(heading.key)).map((heading) => heading.pos),
      );
    };
    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      if (!transaction.docChanged) return;
      if (transaction.getMeta(EXTERNAL_CONTENT_META)) remotePending = true;
      timer ??= setTimeout(recompute, RECOMPUTE_MS);
    };

    editor.on("transaction", onTransaction);
    // Catch up on anything that changed between creating the store and subscribing.
    const latest = extractHeadings(editor.state.doc);
    if (!sameOutline(snapshot.headings, latest)) snapshot = { headings: latest, fresh: EMPTY_KEYS };
    return () => {
      editor.off("transaction", onTransaction);
      clearTimeout(timer);
      unregisterFlash();
    };
  };

  return { subscribe, getSnapshot: () => snapshot };
}

/**
 * The live outline of `editor`. It re-renders only when the heading list
 * changes, not on every keystroke. Headings that appear through a remote
 * write (an agent through the DocRoom) are marked fresh and flashed once in
 * the document; local typing never animates.
 */
export function useOutline(editor: Editor | null): OutlineState {
  const store = useMemo(
    () => (editor && !editor.isDestroyed ? createOutlineStore(editor) : null),
    [editor],
  );
  return useSyncExternalStore(
    store?.subscribe ?? noSubscription,
    store?.getSnapshot ?? emptySnapshot,
  );
}

/** Position of the heading for `key` in the editor's current document. */
export function headingPos(editor: Editor, key: string): number | null {
  return extractHeadings(editor.state.doc).find((candidate) => candidate.key === key)?.pos ?? null;
}

/** Heading DOM for `key` in the editor's current document. */
export function headingElement(editor: Editor, key: string): HTMLElement | null {
  const pos = headingPos(editor, key);
  const element = pos === null ? null : editor.view.nodeDOM(pos);
  return element instanceof HTMLElement ? element : null;
}

// Headings in the top 30% of the viewport count as being read.
const READING_BAND = "0px 0px -70% 0px";

/**
 * The key of the section being read, tracked with an IntersectionObserver so
 * scrolling never triggers layout reads on our side.
 */
export function useActiveHeading(editor: Editor | null, outline: OutlineState) {
  const [active, setActive] = useState<string | null>(null);
  const { headings } = outline;

  useEffect(() => {
    if (!editor || editor.isDestroyed || headings.length === 0) return;
    const order = headings.map((heading) => heading.key);
    const keyByElement = new Map<Element, string>();
    for (const heading of extractHeadings(editor.state.doc)) {
      const element = editor.view.nodeDOM(heading.pos);
      if (element instanceof HTMLElement) keyByElement.set(element, heading.key);
    }
    const inBand = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        const exitedBelow = new Set<string>();
        for (const entry of entries) {
          const key = keyByElement.get(entry.target);
          if (!key) continue;
          if (entry.isIntersecting) {
            inBand.add(key);
          } else {
            inBand.delete(key);
            const bandBottom = entry.rootBounds?.bottom ?? 0;
            if (entry.boundingClientRect.top >= bandBottom) exitedBelow.add(key);
          }
        }
        setActive((previous) => activeAfter(order, previous, inBand, exitedBelow));
      },
      { rootMargin: READING_BAND },
    );
    for (const element of keyByElement.keys()) observer.observe(element);
    return () => observer.disconnect();
  }, [editor, headings]);

  const current = headings.some((heading) => heading.key === active) ? active : null;
  return [current, setActive] as const;
}
