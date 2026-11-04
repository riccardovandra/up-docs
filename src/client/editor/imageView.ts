import type { Editor, NodeViewRendererProps } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { NodeView } from "@tiptap/pm/view";

import { isDocImageSrc, MAX_IMAGE_WIDTH, MIN_IMAGE_WIDTH } from "../../shared/images.ts";

const blockedLabel = (node: ProseMirrorNode) =>
  node.attrs.alt ? `[Image: ${String(node.attrs.alt)}]` : "[Image]";

/**
 * An image with a resize handle on its bottom-right corner. Dragging the
 * handle sets the node's width, which is saved in the markdown; double-clicking
 * it returns the image to its natural size. Sources that are not ours render
 * as their alt text, as in renderHTML.
 */
export class ImageView implements NodeView {
  readonly dom: HTMLElement;
  private readonly img: HTMLImageElement | null = null;
  private readonly editor: Editor;
  private readonly getPos: NodeViewRendererProps["getPos"];
  private node: ProseMirrorNode;
  private resizing = false;

  constructor({ node, editor, getPos }: NodeViewRendererProps) {
    this.node = node;
    this.editor = editor;
    this.getPos = getPos;

    const src = String(node.attrs.src ?? "");
    if (!isDocImageSrc(src)) {
      this.dom = document.createElement("span");
      this.dom.className = "doc-image-blocked";
      this.dom.title = src;
      this.dom.textContent = blockedLabel(node);
      return;
    }

    this.dom = document.createElement("span");
    this.dom.className = "doc-image-frame";
    this.img = document.createElement("img");
    this.img.className = "doc-image";
    this.img.loading = "lazy";
    this.img.src = src;
    this.dom.append(this.img);

    const handle = document.createElement("span");
    handle.className = "doc-image-handle";
    handle.contentEditable = "false";
    handle.title = "Drag to resize. Double-click for the original size.";
    handle.setAttribute("aria-hidden", "true");
    handle.addEventListener("pointerdown", (event) => this.startResize(event, handle));
    handle.addEventListener("dblclick", (event) => {
      event.preventDefault();
      this.commitWidth(null);
    });
    this.dom.append(handle);

    this.render();
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type || node.attrs.src !== this.node.attrs.src) return false;
    this.node = node;
    if (this.img) this.render();
    else this.dom.textContent = blockedLabel(node);
    return true;
  }

  selectNode(): void {
    this.dom.classList.add("ProseMirror-selectednode");
  }

  deselectNode(): void {
    this.dom.classList.remove("ProseMirror-selectednode");
  }

  stopEvent(event: Event): boolean {
    const target = event.target as Element | null;
    return this.resizing || target?.closest?.(".doc-image-handle") != null;
  }

  ignoreMutation(): boolean {
    return true;
  }

  private render(): void {
    const img = this.img!;
    const { alt, title, width } = this.node.attrs;
    img.alt = alt ? String(alt) : "";
    if (title) img.title = String(title);
    else img.removeAttribute("title");
    img.style.width = width ? `${Number(width)}px` : "";
  }

  private startResize(event: PointerEvent, handle: HTMLElement): void {
    if (!this.editor.isEditable || event.button !== 0 || !this.img) return;
    event.preventDefault();
    event.stopPropagation();
    const img = this.img;
    const startX = event.clientX;
    const startWidth = img.getBoundingClientRect().width;
    // The image never grows past the block it sits in.
    const container = this.dom.parentElement?.getBoundingClientRect().width ?? MAX_IMAGE_WIDTH;
    const maxWidth = Math.max(MIN_IMAGE_WIDTH, Math.min(MAX_IMAGE_WIDTH, container));
    const widthAt = (x: number) =>
      Math.round(Math.min(maxWidth, Math.max(MIN_IMAGE_WIDTH, startWidth + x - startX)));

    this.resizing = true;
    this.dom.classList.add("is-resizing");
    handle.setPointerCapture(event.pointerId);
    const move = (moved: PointerEvent) => {
      img.style.width = `${widthAt(moved.clientX)}px`;
    };
    const end = (ended: PointerEvent) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      if (handle.hasPointerCapture(ended.pointerId)) handle.releasePointerCapture(ended.pointerId);
      this.resizing = false;
      this.dom.classList.remove("is-resizing");
      if (ended.type === "pointercancel") this.render();
      else if (ended.clientX !== startX) this.commitWidth(widthAt(ended.clientX));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  private commitWidth(width: number | null): void {
    const pos = this.getPos();
    if (!this.editor.isEditable || typeof pos !== "number") return;
    if (this.node.attrs.width === width) return;
    const { state, dispatch } = this.editor.view;
    dispatch(state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, width }));
  }
}
