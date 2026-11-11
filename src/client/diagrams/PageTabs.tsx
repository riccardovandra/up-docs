import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import {
  diagramPictureUrl,
  isPictureCurrent,
  pagePicture,
  type DiagramSummary,
} from "../../shared/drawio.ts";
import { subscribePathname } from "../router.ts";
import {
  PAGE_KEYS_HINT,
  pageFromSearch,
  pageStep,
  searchForPage,
  steppedPage,
} from "./pageTabsLogic.ts";
import "./diagrams.css";

const searchListeners = new Set<() => void>();
const subscribeSearch = (listener: () => void) => {
  searchListeners.add(listener);
  const stop = subscribePathname(listener);
  return () => {
    searchListeners.delete(listener);
    stop();
  };
};

/**
 * The shown page, kept in the address as `?page=N` so a link or a reload
 * opens it. A switch replaces the address, as a sheet's tab does, so Back
 * leaves the diagram instead of walking through its pages.
 */
export function useUrlPage(
  names: ReadonlyArray<string | null>,
): readonly [number, (index: number) => void] {
  const search = useSyncExternalStore(subscribeSearch, () => window.location.search);
  const index = pageFromSearch(search, names);
  const select = useCallback((next: number) => {
    const { pathname, search: current, hash } = window.location;
    const url = `${pathname}${searchForPage(current, next)}${hash}`;
    window.history.replaceState(window.history.state, "", url);
    for (const listener of searchListeners) listener();
  }, []);
  return [index, select] as const;
}

/**
 * Loads the pictures of the pages either side of the shown one, so a switch
 * shows them at once. Picture addresses carry their version and are cached for
 * good, so the browser keeps them. A page whose picture is missing or behind
 * is left to the picture itself, which has it drawn when it is shown.
 */
export function usePreloadedPages(
  diagram: Pick<
    DiagramSummary,
    "id" | "version" | "pictureVersion" | "picturePages" | "hasSource"
  > | null,
  names: ReadonlyArray<string | null>,
  index: number,
): void {
  const neighbours = [index - 1, index + 1]
    .filter((at) => at >= 0 && at < names.length)
    .map((at) => {
      if (!diagram || !isPictureCurrent(diagram) || diagram.pictureVersion === null) return null;
      const shown = pagePicture(diagram, names[at] ?? null);
      return shown.kind === "picture"
        ? diagramPictureUrl(diagram.id, "svg", diagram.pictureVersion, shown.index)
        : null;
    })
    .filter((url): url is string => url !== null);
  const key = neighbours.join(" ");
  useEffect(() => {
    if (key === "") return;
    for (const url of key.split(" ")) {
      const image = new Image();
      image.decoding = "async";
      image.src = url;
    }
  }, [key]);
}

/**
 * The page tabs along the bottom of the diagram view, styled as a sheet's
 * tabs: one per page, the shown one raised, a count on pages with open
 * comments. PageUp and PageDown switch pages while `keys` is on and no field
 * has focus. Nothing shows for a diagram of one page.
 */
export function PageTabs(props: {
  readonly names: ReadonlyArray<string | null>;
  readonly active: number;
  readonly onSelect: (index: number) => void;
  /** Open comment threads per page, in page order. */
  readonly openCounts: ReadonlyArray<number>;
  /** Off while something else, such as the editor, has the keyboard. */
  readonly keys: boolean;
}) {
  const { names, active, onSelect, keys } = props;
  const count = names.length;
  const bar = useRef<HTMLDivElement>(null);

  // The shown tab stays in view when the bar scrolls (a phone, many pages); the page itself does not move.
  useEffect(() => {
    const host = bar.current;
    const tab = host?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!host || !tab) return;
    // The bar's own padding is kept in view with the first tab.
    if (tab.offsetLeft < host.scrollLeft + 8) host.scrollLeft = Math.max(0, tab.offsetLeft - 8);
    else if (tab.offsetLeft + tab.offsetWidth > host.scrollLeft + host.clientWidth) {
      host.scrollLeft = tab.offsetLeft + tab.offsetWidth - host.clientWidth;
    }
    // Counts arriving widen the tabs, so they move the shown one too.
  }, [active, count, props.openCounts.join(" ")]);

  useEffect(() => {
    if (!keys || count < 2) return;
    const onKey = (event: KeyboardEvent) => {
      const step = pageStep(event);
      if (step === 0) return;
      event.preventDefault();
      const next = steppedPage(active, step, count);
      if (next !== active) onSelect(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keys, count, active, onSelect]);

  if (count < 2) return null;
  return (
    <div ref={bar} className="diagram-page-tabs" role="tablist" aria-label="Pages" title={PAGE_KEYS_HINT}>
      {names.map((name, index) => {
        const label = name ?? `Page ${index + 1}`;
        const open = props.openCounts[index] ?? 0;
        return (
          <button
            key={`${index}:${name}`}
            type="button"
            role="tab"
            aria-selected={index === active}
            className="diagram-page-tab"
            title={`${label} (page ${index + 1} of ${count}). ${PAGE_KEYS_HINT}.`}
            onClick={() => onSelect(index)}
          >
            {label}
            {open > 0 ? (
              <span
                className="diagram-page-tab-count"
                aria-label={`${open} open comment${open === 1 ? "" : "s"}`}
              >
                {open}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
