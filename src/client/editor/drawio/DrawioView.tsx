import type { Editor, NodeViewRendererProps } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { NodeView } from "@tiptap/pm/view";
import { useEffect, useState, type MouseEvent } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  diagramPath,
  isDrawioLanguage,
  parseDrawioBlock,
  type DiagramUsage,
  type DrawioBlock,
} from "../../../shared/drawio.ts";
import { ApiError } from "../../api.ts";
import { DiagramPicture } from "../../diagrams/DiagramPicture.tsx";
import { diagramErrorMessage, diagramsApi, subscribeDiagram } from "../../diagrams/diagramsApi.ts";
import { DiagramIcon, LinkIcon } from "../../home/icons.tsx";
import { navigate } from "../../router.ts";
import {
  blockActions,
  blockDiagram,
  detachCopy,
  mergeDiagram,
  usageLine,
  type BlockAction,
  type BlockDiagram,
} from "./blockLogic.ts";
import {
  relinkDrawioBlock,
  removeDrawioBlock,
  type DrawioSupportStorage,
} from "./drawioSupport.ts";
import "./drawio.css";

/** A diagram as a block has it: known, gone (or not shared), unreachable, or not loaded yet. */
type Loaded = BlockDiagram | "missing" | "failed" | null;

const isKnown = (loaded: Loaded): loaded is BlockDiagram =>
  loaded !== null && typeof loaded === "object";

/** Follows one diagram: what this editor last saw, then the server's answer, then every save. */
function useBlockDiagram(diagramId: string, known: Map<string, BlockDiagram> | undefined): Loaded {
  const [loaded, setLoaded] = useState<Loaded>(() => known?.get(diagramId) ?? null);

  useEffect(() => {
    let live = true;
    diagramsApi.get(diagramId).then(
      (diagram) => {
        if (live) setLoaded((current) => mergeDiagram(isKnown(current) ? current : null, diagram));
      },
      (cause: unknown) => {
        if (!live) return;
        if (cause instanceof ApiError && cause.status === 404) setLoaded("missing");
        // What was already on screen is better than an error.
        else setLoaded((current) => (isKnown(current) ? current : "failed"));
      },
    );
    const stop = subscribeDiagram(diagramId, (next) =>
      setLoaded((current) =>
        next === null ? "missing" : mergeDiagram(isKnown(current) ? current : null, next),
      ),
    );
    return () => {
      live = false;
      stop();
    };
  }, [diagramId]);

  useEffect(() => {
    if (isKnown(loaded)) known?.set(diagramId, loaded);
    else if (loaded === "missing") known?.delete(diagramId);
  }, [diagramId, known, loaded]);

  return loaded;
}

function LinkedFigure(props: {
  readonly block: DrawioBlock;
  readonly editable: boolean;
  readonly support: DrawioSupportStorage | undefined;
  /** Whether the person can still edit the doc, asked at the moment of an action. */
  readonly canChange: () => boolean;
  readonly onRemove: () => boolean;
  readonly onRelink: (diagramId: string) => boolean;
}) {
  const { block, support } = props;
  const { diagramId } = block;
  const loaded = useBlockDiagram(diagramId, support?.known);
  const diagram = isKnown(loaded) ? loaded : null;
  const context = support?.context() ?? null;
  const docId = context?.docId ?? null;
  const [usage, setUsage] = useState<DiagramUsage | null>(null);
  const [busy, setBusy] = useState(false);

  // Only someone who manages the diagram may know which docs link it.
  const manages = diagram?.canEdit === true;
  useEffect(() => {
    if (!manages || docId === null) return;
    let live = true;
    diagramsApi.uses(diagramId).then(
      (next) => {
        if (live) setUsage(next);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [manages, diagramId, docId]);

  const actions = blockActions({
    docEditable: props.editable,
    diagram,
    hosted: context !== null,
  });
  const canEdit = actions.some((action) => action.id === "edit" && action.disabled === null);

  const edit = () => {
    if (props.canChange()) support?.context()?.edit(diagramId);
  };

  const detach = async () => {
    const page = support?.context();
    if (!page || busy || !props.canChange()) return;
    setBusy(true);
    try {
      const copy = await detachCopy(diagramsApi, { diagramId, projectId: page.projectId });
      // Known before the block points at it, so the copy shows without a second load.
      support?.known.set(copy.id, blockDiagram(copy));
      page.notify(
        props.onRelink(copy.id)
          ? "This doc now has its own copy. The original is unchanged."
          : `The copy "${copy.title}" is in Diagrams, but its block is no longer in this tab.`,
      );
    } catch (cause) {
      page.notify(`Could not detach a copy. ${diagramErrorMessage(cause)}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = () => {
    if (props.onRemove()) {
      support?.context()?.notify("Removed from this doc. The diagram stays in Diagrams.");
    }
  };

  const run = (action: BlockAction) => {
    if (action.disabled !== null || busy) return;
    if (action.id === "edit") edit();
    else if (action.id === "detach") void detach();
    else if (action.id === "remove") remove();
  };

  const open = (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    navigate(diagramPath(diagramId));
  };

  const caption = block.caption ?? diagram?.title ?? null;
  const picture = diagram ? (
    <DiagramPicture
      diagramId={diagramId}
      diagram={diagram}
      className="drawio-picture"
      {...(block.caption ? { alt: block.caption } : {})}
    />
  ) : null;

  return (
    <figure className="drawio-figure" data-status={diagram ? "linked" : (loaded ?? "loading")}>
      <span className="diagram-chip linked drawio-tag">
        <LinkIcon size={12} />
        Linked diagram
      </span>
      {actions.length > 0 ? (
        <div className="drawio-actions" role="group" aria-label="Diagram actions">
          {actions.map((action) =>
            action.id === "open" ? (
              <a
                key={action.id}
                className="drawio-action"
                href={diagramPath(diagramId)}
                onClick={open}
              >
                {action.label}
              </a>
            ) : (
              <button
                key={action.id}
                type="button"
                className="drawio-action"
                // Not `disabled`: a greyed-out action still has to say why on hover and to a reader.
                aria-disabled={action.disabled !== null || busy}
                title={action.disabled ?? undefined}
                onClick={() => run(action)}
              >
                {action.id === "detach" && busy ? "Copying…" : action.label}
              </button>
            ),
          )}
        </div>
      ) : null}
      {picture === null ? (
        <div className="drawio-stage" role="status" aria-busy={loaded === null}>
          {loaded === "missing" ? (
            <>
              <strong>Diagram not found</strong>
              <span>It was deleted, or it is not shared with you.</span>
            </>
          ) : loaded === "failed" ? (
            <>
              <strong>Diagram could not be loaded</strong>
              <span>Check your connection, then reload the page.</span>
            </>
          ) : null}
        </div>
      ) : canEdit ? (
        <button
          type="button"
          className="drawio-stage drawio-stage-button"
          title="Click to edit"
          onClick={edit}
        >
          {picture}
        </button>
      ) : (
        <div className="drawio-stage">{picture}</div>
      )}
      {caption !== null || usage !== null ? (
        <figcaption className="drawio-caption">
          <DiagramIcon size={14} />
          <span className="drawio-caption-text">{caption}</span>
          {usage !== null && docId !== null ? (
            <span className="drawio-usage">{usageLine(usage, docId)}</span>
          ) : null}
        </figcaption>
      ) : null}
    </figure>
  );
}

/**
 * A ```t3-drawio block: the linked diagram's picture on a white card, its
 * caption, and for people who can edit the doc the actions Edit, Open in
 * Diagrams, Detach a copy and Remove. The diagram itself lives in the library,
 * so the block holds only its id and an optional caption. As with a video, the
 * caret entering the block shows that source, which is how a caption is typed.
 */
export class DrawioView implements NodeView {
  readonly dom = document.createElement("div");
  readonly contentDOM = document.createElement("code");
  private readonly root: Root;
  private readonly editor: Editor;
  private readonly getPos: NodeViewRendererProps["getPos"];
  private node: ProseMirrorNode;
  /** What the figure was last drawn from; anything else is a repaint. */
  private painted: string | null = null;
  private destroyed = false;

  constructor({ node, editor, getPos }: NodeViewRendererProps) {
    this.node = node;
    this.editor = editor;
    this.getPos = getPos;

    this.dom.className = "drawio-block";
    const pre = document.createElement("pre");
    pre.className = "drawio-source";
    pre.append(this.contentDOM);
    const chrome = document.createElement("div");
    chrome.className = "drawio-chrome";
    chrome.contentEditable = "false";
    // Keep the browser from placing a caret in the figure, and the editor's selection where it is.
    chrome.addEventListener("mousedown", (event) => event.preventDefault());
    this.dom.append(pre, chrome);
    this.root = createRoot(chrome);

    editor.on("selectionUpdate", this.sync);
    editor.on("focus", this.sync);
    editor.on("blur", this.sync);
    // Nothing announces a change of the right to edit (the page turns it on and off quietly), so
    // the block looks again whenever the pointer or the keyboard reaches it, before its actions show.
    this.dom.addEventListener("pointerenter", this.sync);
    this.dom.addEventListener("focusin", this.sync);
    this.sync();
  }

  update(node: ProseMirrorNode) {
    if (node.type !== this.node.type || !isDrawioLanguage(node.attrs.language as string | null)) {
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
    this.editor.off("selectionUpdate", this.sync);
    this.editor.off("focus", this.sync);
    this.editor.off("blur", this.sync);
    // The editor can drop a view while React is rendering; a root may not be unmounted then.
    queueMicrotask(() => this.root.unmount());
  }

  private get support(): DrawioSupportStorage | undefined {
    return (this.editor.storage as { drawioSupport?: DrawioSupportStorage }).drawioSupport;
  }

  /** Where the block is now; null once the view is gone. */
  private position(): number | null {
    if (this.destroyed) return null;
    const pos = this.getPos();
    return typeof pos === "number" ? pos : null;
  }

  /** Looks again first, so a block that has gone read-only drops its actions on the spot. */
  private readonly canChange = (): boolean => {
    this.sync();
    return !this.destroyed && this.editor.isEditable;
  };

  private readonly remove = (): boolean => {
    const pos = this.position();
    return pos !== null && removeDrawioBlock(this.editor, pos);
  };

  /** Points the block at another diagram, keeping its caption. False when the block is gone. */
  private readonly relink = (diagramId: string): boolean => {
    const pos = this.position();
    return pos !== null && relinkDrawioBlock(this.editor, pos, diagramId);
  };

  /** Repaints when the source or the right to edit changed, and tracks the caret. */
  private readonly sync = () => {
    if (this.destroyed) return;
    const source = this.node.textContent;
    const editable = this.editor.isEditable;
    const key = `${editable}\n${source}`;
    if (key !== this.painted) {
      this.painted = key;
      const block = parseDrawioBlock(source);
      this.dom.dataset.state = block ? "linked" : "invalid";
      this.root.render(
        block ? (
          <LinkedFigure
            // A block pointed at another diagram starts over.
            key={block.diagramId}
            block={block}
            editable={editable}
            support={this.support}
            canChange={this.canChange}
            onRemove={this.remove}
            onRelink={this.relink}
          />
        ) : (
          <p className="drawio-message">
            {source.trim() === ""
              ? "Use Insert diagram to link a diagram here."
              : "This is not a diagram link. Its first line must be the id of a diagram."}
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
