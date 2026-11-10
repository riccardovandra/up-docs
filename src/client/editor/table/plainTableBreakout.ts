import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

import { growRight, overlaps } from "./tableFit.ts";

/** Room for the collapsed borders, so a table at its set width does not scroll by a pixel. */
const BORDER_SLACK = 2;

/**
 * Lets a plain table whose columns were dragged wider than the text column
 * grow right into the page, the way rich tables break out. Widths come from
 * the table's inline width or min-width, which the table view sets from the
 * column widths, and are re-read whenever the table or the page changes size,
 * including live while a column is dragged.
 */
class BreakoutView {
  private frame = 0;
  private readonly sizes = new ResizeObserver(() => this.schedule());
  private readonly watched = new Set<Element>();

  private readonly view: EditorView;

  constructor(view: EditorView) {
    this.view = view;
    this.schedule();
  }

  update() {
    this.schedule();
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.sizes.disconnect();
  }

  private schedule() {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.fit());
  }

  private watch(element: Element | null) {
    if (!element || this.watched.has(element)) return;
    this.watched.add(element);
    this.sizes.observe(element);
  }

  private fit() {
    const root = this.view.dom;
    const main = root.closest(".doc-main");
    for (const element of this.watched) {
      if (!element.isConnected) {
        this.sizes.unobserve(element);
        this.watched.delete(element);
      }
    }
    if (!main) return;
    this.watch(main);
    const pageBox = main.getBoundingClientRect();
    const pageStyle = getComputedStyle(main);
    const page = {
      left: pageBox.left + parseFloat(pageStyle.paddingLeft),
      right: pageBox.right - parseFloat(pageStyle.paddingRight),
    };
    const margin = root.closest(".doc-body")?.querySelector(".comment-margin");
    for (const wrapper of root.querySelectorAll<HTMLElement>(".tableWrapper")) {
      const table = wrapper.querySelector("table");
      const parent = wrapper.parentElement;
      if (!table || !parent) continue;
      this.watch(table);
      const required = parseFloat(table.style.width || table.style.minWidth) || 0;
      const band = wrapper.getBoundingClientRect();
      const commentBeside = [...(margin?.children ?? [])].some((item) =>
        overlaps(band, item.getBoundingClientRect()),
      );
      const width = growRight({
        required: required + BORDER_SLACK,
        column: parent.getBoundingClientRect(),
        page,
        commentBeside,
      });
      const value = width === null ? "" : `${width}px`;
      if (wrapper.style.width !== value) wrapper.style.width = value;
      wrapper.classList.toggle("table-wide", width !== null);
    }
  }
}

export const TableBreakout = Extension.create({
  name: "tableBreakout",
  addProseMirrorPlugins() {
    return [new Plugin({ view: (view) => new BreakoutView(view) })];
  },
});
