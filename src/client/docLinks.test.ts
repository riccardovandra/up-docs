import { afterEach, describe, expect, it, vi } from "vitest";
import type { Plugin } from "@tiptap/pm/state";

import { followClickedLink, resolveDocLink } from "./docLinks.ts";
import { createEditorExtensions } from "./editor/extensions.ts";
import { LinkClick } from "./editor/linkClick.ts";

const here = { origin: "https://docs.example.com", pathname: "/d/doc1/tab1" };

describe("resolveDocLink", () => {
  it("keeps a tab of this doc in place", () => {
    expect(resolveDocLink("https://docs.example.com/d/doc1/tab2", here)?.appPath).toBe(
      "/d/doc1/tab2",
    );
  });

  it("keeps a tab of this doc in place when written with another origin", () => {
    expect(resolveDocLink("https://old.example.org/d/doc1/tab2", here)?.appPath).toBe(
      "/d/doc1/tab2",
    );
  });

  it("opens another doc of this app in place", () => {
    expect(resolveDocLink("https://docs.example.com/d/doc2", here)?.appPath).toBe("/d/doc2");
    expect(resolveDocLink("/d/doc2/tab9", here)?.appPath).toBe("/d/doc2/tab9");
  });

  it("sends another instance's doc and other sites outside", () => {
    const url = "https://old.example.org/d/doc2/tab9";
    expect(resolveDocLink(url, here)).toEqual({ url, appPath: null });
    expect(resolveDocLink("https://example.com/d", here)?.appPath).toBeNull();
    expect(resolveDocLink("mailto:a@example.com", here)?.appPath).toBeNull();
  });

  it("sends paths this app does not route outside", () => {
    expect(resolveDocLink("/api/images/1", here)?.appPath).toBeNull();
  });

  it("refuses anything but web and mail links", () => {
    expect(resolveDocLink("javascript:alert(1)", here)).toBeNull();
    expect(resolveDocLink("https://", here)).toBeNull();
  });
});

function click(href: string | null, init: Partial<MouseEvent> = {}) {
  const anchor = href === null ? null : { getAttribute: () => href };
  return {
    button: 0,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    target: { closest: () => anchor },
    preventDefault: vi.fn(),
    ...init,
  } as unknown as MouseEvent & { preventDefault: ReturnType<typeof vi.fn> };
}

function stubWindow(collapsed = true) {
  const win = {
    location: { origin: here.origin, pathname: here.pathname },
    history: {
      pushState: vi.fn((_state: unknown, _title: string, path: string) => {
        win.location.pathname = path;
      }),
    },
    getSelection: () => ({ isCollapsed: collapsed }),
    open: vi.fn(),
  };
  vi.stubGlobal("window", win);
  return win;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("followClickedLink", () => {
  it("routes a tab link inside the app", () => {
    const win = stubWindow();
    const event = click(`${here.origin}/d/doc1/tab2`);
    expect(followClickedLink(event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(win.location.pathname).toBe("/d/doc1/tab2");
    expect(win.open).not.toHaveBeenCalled();
  });

  it("opens an external link in a new tab", () => {
    const win = stubWindow();
    expect(followClickedLink(click("https://example.com/a"))).toBe(true);
    expect(win.open).toHaveBeenCalledWith(
      "https://example.com/a",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("opens an app link in a new tab on Cmd/Ctrl+click", () => {
    const win = stubWindow();
    followClickedLink(click(`${here.origin}/d/doc1/tab2`, { metaKey: true }));
    expect(win.open).toHaveBeenCalled();
    expect(win.location.pathname).toBe(here.pathname);
  });

  it("leaves Alt, Shift, other buttons and a drag selection to the editor", () => {
    const win = stubWindow();
    expect(followClickedLink(click("/d/doc1/tab2", { altKey: true }))).toBe(false);
    expect(followClickedLink(click("/d/doc1/tab2", { shiftKey: true }))).toBe(false);
    expect(followClickedLink(click("/d/doc1/tab2", { button: 1 }))).toBe(false);
    expect(win.history.pushState).not.toHaveBeenCalled();
    stubWindow(false);
    expect(followClickedLink(click("/d/doc1/tab2"))).toBe(false);
  });

  it("opens a link once when the table and the editor both see the click", () => {
    const win = stubWindow();
    const event = click("https://example.com/a", { defaultPrevented: true });
    expect(followClickedLink(event)).toBe(false);
    expect(win.open).not.toHaveBeenCalled();
  });

  it("ignores a click outside a link", () => {
    stubWindow();
    expect(followClickedLink(click(null))).toBe(false);
  });

  it("does not open a refused address", () => {
    const win = stubWindow();
    const event = click("javascript:alert(1)");
    expect(followClickedLink(event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(win.open).not.toHaveBeenCalled();
  });
});

describe("editor wiring", () => {
  it("is part of the editor and routes its clicks", () => {
    expect(createEditorExtensions().some((extension) => extension.name === "linkClick")).toBe(true);
    const [plugin] = LinkClick.config.addProseMirrorPlugins!.call({} as never) as Array<Plugin>;
    const win = stubWindow();
    const onClick = plugin!.props.handleDOMEvents!.click as unknown as (
      view: unknown,
      event: MouseEvent,
    ) => boolean;
    onClick({}, click("/d/doc1/tab2"));
    expect(win.location.pathname).toBe("/d/doc1/tab2");
  });
});
