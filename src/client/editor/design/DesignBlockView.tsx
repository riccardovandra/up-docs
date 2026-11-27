import type { Editor, NodeViewRendererProps } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { NodeView } from "@tiptap/pm/view";
import { useEffect, useState, type MouseEvent } from "react";
import { createRoot, type Root } from "react-dom/client";

import { designPath, designPictureUrl, type DesignSummary } from "../../../shared/design.ts";
import {
  designCaption,
  isDesignLanguage,
  parseDesignBlock,
  type DesignBlock,
} from "../../../shared/designBlock.ts";
import { ApiError } from "../../api.ts";
import { DesignIcon } from "../../designs/DesignIcon.tsx";
import { useDiagramChanges } from "../../diagrams/drawioEditing.ts";
import { navigate } from "../../router.ts";
import { designDocsApi, watchDesign } from "./designRefresh.ts";
import { removeDesignBlock } from "./designBlockSteps.ts";
import "../drawio/drawio.css";
import "./design.css";

/** A design as a block has it: known, gone (or not shown to the person), unreachable, or loading. */
type Loaded = DesignSummary | "missing" | "failed" | null;

const isKnown = (loaded: Loaded): loaded is DesignSummary =>
  loaded !== null && typeof loaded === "object";

/** The later of two reads: a re-read that crossed a newer one never rolls the picture back. */
const later = (current: Loaded, next: DesignSummary): DesignSummary =>
  isKnown(current) && current.id === next.id && current.version > next.version ? current : next;

/** Follows one design: the first read, then every re-read of the page. */
function useBlockDesign(designId: string): Loaded {
  const [loaded, setLoaded] = useState<Loaded>(null);
  useEffect(() => {
    let live = true;
    designDocsApi.get(designId).then(
      (design) => {
        if (live) setLoaded((current) => later(current, design));
      },
      (cause: unknown) => {
        if (!live) return;
        if (cause instanceof ApiError && cause.status === 404) setLoaded("missing");
        // What was already on screen is better than an error.
        else setLoaded((current) => (isKnown(current) ? current : "failed"));
      },
    );
    const unwatch = watchDesign(designId, (next) => {
      if (live) setLoaded((current) => (next === null ? "missing" : later(current, next)));
    });
    return () => {
      live = false;
      unwatch();
    };
  }, [designId]);
  return loaded;
}

function DesignFigure(props: {
  readonly block: DesignBlock;
  readonly editable: boolean;
  readonly onRemove: () => boolean;
}) {
  const { block } = props;
  const loaded = useBlockDesign(block.designId);
  const design = isKnown(loaded) ? loaded : null;
  /** False on a phone or tablet: the block is a picture with Open, nothing else. */
  const changesHere = useDiagramChanges();
  const picture = design ? designPictureUrl(design) : null;
  const caption = designCaption(block, design?.title ?? null);

  const open = (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    navigate(designPath(block.designId));
  };

  return (
    <figure className="drawio-figure design-figure" data-status={design ? "linked" : (loaded ?? "loading")}>
      <span className="diagram-chip linked drawio-tag">
        <DesignIcon size={12} />
        Design
      </span>
      {loaded !== "missing" || (props.editable && changesHere) ? (
        <div className="drawio-actions" role="group" aria-label="Design actions">
          {loaded !== "missing" ? (
            <a className="drawio-action" href={designPath(block.designId)} onClick={open}>
              Open
            </a>
          ) : null}
          {props.editable && changesHere ? (
            <button type="button" className="drawio-action" onClick={() => props.onRemove()}>
              Remove
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="drawio-stage design-stage" role={picture ? undefined : "status"}>
        {picture && design ? (
          <a href={designPath(block.designId)} onClick={open} className="design-block-picture">
            <img src={picture} alt={block.caption ?? design.title} decoding="async" />
          </a>
        ) : loaded === "missing" ? (
          <>
            <strong>Design not found</strong>
            <span>It was deleted, or it is not shared with you.</span>
          </>
        ) : loaded === "failed" ? (
          <>
            <strong>Design could not be loaded</strong>
            <span>Check your connection, then reload the page.</span>
          </>
        ) : design ? (
          <>
            <strong>No picture yet</strong>
            <span>Open the design and draw something; its picture shows here.</span>
          </>
        ) : null}
      </div>
      {caption !== null ? (
        <figcaption className="drawio-caption">
          <DesignIcon size={14} />
          <span className="drawio-caption-text">{caption}</span>
        </figcaption>
      ) : null}
    </figure>
  );
}

/**
 * A ```t3-design block (S4): the design's saved picture on a white card, its
 * caption, Open (to the design page) for everyone, and Remove for people who
 * edit the doc on a computer. The design lives in the library, so the block
 * holds only its id, an optional frame line and an optional caption; the caret
 * entering the block shows that source, which is how a caption is typed.
 */
export class DesignBlockView implements NodeView {
  readonly dom = document.createElement("div");
  readonly contentDOM = document.createElement("code");
  private readonly root: Root;
  private readonly editor: Editor;
  private readonly getPos: NodeViewRendererProps["getPos"];
  private node: ProseMirrorNode;
  private painted: string | null = null;
  private destroyed = false;

  constructor({ node, editor, getPos }: NodeViewRendererProps) {
    this.node = node;
    this.editor = editor;
    this.getPos = getPos;
    // The Draw.io block's classes: the same card, actions, source toggle and print rules.
    this.dom.className = "drawio-block design-block";
    const pre = document.createElement("pre");
    pre.className = "drawio-source";
    pre.append(this.contentDOM);
    const chrome = document.createElement("div");
    chrome.className = "drawio-chrome";
    chrome.contentEditable = "false";
    chrome.addEventListener("mousedown", (event) => event.preventDefault());
    this.dom.append(pre, chrome);
    this.root = createRoot(chrome);
    editor.on("transaction", this.sync);
    editor.on("focus", this.sync);
    editor.on("blur", this.sync);
    this.sync();
  }

  update(node: ProseMirrorNode) {
    if (node.type !== this.node.type || !isDesignLanguage(node.attrs.language as string | null)) {
      return false;
    }
    this.node = node;
    this.sync();
    return true;
  }

  // The figure and its buttons are ours, not ProseMirror's.
  stopEvent(event: Event) {
    return event.target instanceof Node && !this.contentDOM.contains(event.target);
  }

  ignoreMutation(mutation: MutationRecord | { type: "selection"; target: Node }) {
    return mutation.type !== "selection" && !this.contentDOM.contains(mutation.target);
  }

  destroy() {
    this.destroyed = true;
    this.editor.off("transaction", this.sync);
    this.editor.off("focus", this.sync);
    this.editor.off("blur", this.sync);
    // The editor can drop a view while React is rendering; a root may not be unmounted then.
    queueMicrotask(() => this.root.unmount());
  }

  private readonly remove = (): boolean => {
    if (this.destroyed) return false;
    const pos = this.getPos();
    return typeof pos === "number" && removeDesignBlock(this.editor, pos);
  };

  private readonly sync = () => {
    if (this.destroyed) return;
    const source = this.node.textContent;
    const editable = this.editor.isEditable;
    const key = `${editable}\n${source}`;
    if (key !== this.painted) {
      this.painted = key;
      const block = parseDesignBlock(source);
      this.dom.dataset.state = block ? "linked" : "invalid";
      this.root.render(
        block ? (
          <DesignFigure
            key={block.designId}
            block={block}
            editable={editable}
            onRemove={this.remove}
          />
        ) : (
          <p className="drawio-message">
            {source.trim() === ""
              ? "Use Design in the + menu to show a design here."
              : "This is not a design link. Its first line must be the id of a design."}
          </p>
        ),
      );
    }
    const pos = this.getPos();
    const { from, to } = this.editor.state.selection;
    const editing =
      this.editor.isFocused &&
      typeof pos === "number" &&
      from > pos &&
      to < pos + this.node.nodeSize;
    this.dom.toggleAttribute("data-editing", editing);
  };
}
