import { describe, expect, it } from "vitest";

import { createEditorExtensions } from "./extensions.ts";
import { pastedLinkHref } from "./linkPaste.ts";

describe("pastedLinkHref", () => {
  it("takes one address, ignoring the spaces and line breaks around it", () => {
    expect(pastedLinkHref("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(pastedLinkHref("  https://example.com/a\r\n")).toBe("https://example.com/a");
    expect(pastedLinkHref("mailto:a@example.com")).toBe("mailto:a@example.com");
    expect(pastedLinkHref("www.example.com/x")).toBe("https://www.example.com/x");
  });

  it("leaves anything else to the editor", () => {
    expect(pastedLinkHref("")).toBeNull();
    expect(pastedLinkHref("see https://example.com")).toBeNull();
    expect(pastedLinkHref("https://a.com https://b.com")).toBeNull();
    expect(pastedLinkHref("example.com")).toBeNull();
    expect(pastedLinkHref("javascript:alert(1)")).toBeNull();
    expect(pastedLinkHref("https://")).toBeNull();
  });

  it("is part of the editor", () => {
    expect(createEditorExtensions().some((extension) => extension.name === "linkPaste")).toBe(true);
  });
});
