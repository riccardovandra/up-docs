import type { MouseEvent } from "react";

import { CloseIcon, DiagramIcon, DocIcon, HomeIcon } from "./home/icons.tsx";
import {
  closeOpenTab,
  openTabKey,
  openTabKind,
  rememberTab,
  type OpenTab,
} from "./openTabs.ts";
import { SheetIcon } from "./sheets/SheetIcon.tsx";
import { navigate, parseRoute, subscribePathname, type Route } from "./router.ts";

const follow = (path: string) => (event: MouseEvent) => {
  if (event.metaKey || event.ctrlKey) return;
  event.preventDefault();
  navigate(path);
};

function TabIcon(props: { readonly tabKey: string }) {
  const kind = openTabKind(props.tabKey);
  if (kind === "diagram") return <DiagramIcon size={14} />;
  if (kind === "sheet") return <SheetIcon size={14} />;
  return <DocIcon size={14} />;
}

/** Home plus one tab per open doc, diagram or sheet, above whichever page is showing. */
export function OpenTabsStrip(props: {
  readonly tabs: ReadonlyArray<OpenTab>;
  readonly route: Route;
}) {
  const activeKey = openTabKey(props.route);
  return (
    <nav className="open-tabs" aria-label="Open docs">
      <a
        href="/"
        className="open-tab open-tab-home"
        aria-label="UP Docs home"
        aria-current={
          props.route.name === "library" ||
          props.route.name === "diagrams" ||
          props.route.name === "sheets"
            ? "page"
            : undefined
        }
        onClick={follow("/")}
      >
        <HomeIcon size={15} />
      </a>
      {props.tabs.map((tab) => (
        <div
          key={tab.key}
          className="open-tab"
          aria-current={tab.key === activeKey ? "page" : undefined}
          onAuxClick={(event) => {
            if (event.button === 1) closeOpenTab(tab.key);
          }}
        >
          <a href={tab.path} className="open-tab-link" onClick={follow(tab.path)}>
            <TabIcon tabKey={tab.key} />
            <span className="open-tab-title">{tab.title}</span>
          </a>
          <button
            type="button"
            className="open-tab-close"
            aria-label={`Close ${tab.title}`}
            onClick={() => closeOpenTab(tab.key)}
          >
            <CloseIcon size={13} />
          </button>
        </div>
      ))}
    </nav>
  );
}

/**
 * Every doc, diagram and sheet visited, however it was reached, gets a tab.
 * Cmd/Ctrl-click on a link to one opens it in a background tab, as a browser would.
 */
export function startOpenTabs(): void {
  const visit = () => rememberTab(window.location.pathname);
  visit();
  subscribePathname(visit);
  window.addEventListener(
    "click",
    (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.button !== 0) return;
      const link = (event.target as Element | null)?.closest?.("a[href]");
      if (!(link instanceof HTMLAnchorElement)) return;
      const url = new URL(link.href);
      if (url.origin !== window.location.origin) return;
      if (openTabKey(parseRoute(url.pathname)) === null) return;
      event.preventDefault();
      event.stopPropagation();
      rememberTab(url.pathname);
    },
    { capture: true },
  );
}
