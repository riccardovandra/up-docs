import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TabEditorBoundary, TabEditorFallback } from "./TabEditor.tsx";

describe("TabEditorBoundary", () => {
  it("fails closed on a render error", () => {
    expect(TabEditorBoundary.getDerivedStateFromError()).toEqual({ failed: true });
  });

  it("shows the stored markdown as text", () => {
    const html = renderToStaticMarkup(<TabEditorFallback markdown="# Title <b>" />);
    expect(html).toContain("# Title &lt;b&gt;");
    expect(html).toContain('role="alert"');
  });
});
