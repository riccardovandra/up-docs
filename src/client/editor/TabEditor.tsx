import type { Editor } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import {
  Component,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";

import type { EmbedLoader } from "./embed/embedSupport.ts";
import { createEditorExtensions } from "./extensions.ts";

export const EXTERNAL_CONTENT_META = "docsCloudExternalContent";

interface TabEditorProps {
  readonly markdown: string;
  readonly revision: number;
  readonly onChange: (markdown: string) => void;
  readonly onEditor?: (editor: Editor | null) => void;
  /** False for viewers and commenters: the text can be selected, not changed. */
  readonly editable: boolean;
  /** Uploads a pasted or dropped image; resolves to its URL. */
  readonly uploadImage: (file: File) => Promise<string>;
  readonly onUploadError: (error: unknown) => void;
  /** Copies an image link into the doc; absent where there is no server to copy it. */
  readonly importImageLink?: (url: string) => Promise<string>;
  /** Takes a pasted or dropped video; `at` is the drop position. */
  readonly onVideoFile: (file: File, at: number | null) => void;
  /** The doc's saved copies of embedded posts; absent where there are none (project files). */
  readonly loadEmbed?: EmbedLoader;
}

/** Shown when a tab's markdown cannot be opened. It never writes, so the stored text stays safe. */
export function TabEditorFallback(props: { readonly markdown: string }) {
  return (
    <div className="tab-editor-fallback" role="alert">
      <p>
        This tab could not be opened in the editor. Its text is unchanged and
        shown below.
      </p>
      <pre>{props.markdown}</pre>
    </div>
  );
}

/**
 * Contains an editor crash to its tab, so bad content cannot blank the page.
 * New markdown gets a fresh attempt.
 */
export class TabEditorBoundary extends Component<
  { readonly markdown: string; readonly children: ReactNode },
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    console.error("Tab editor crashed", error);
  }

  override componentDidUpdate(previous: { readonly markdown: string }) {
    if (this.state.failed && previous.markdown !== this.props.markdown) {
      this.setState({ failed: false });
    }
  }

  override render() {
    if (this.state.failed)
      return <TabEditorFallback markdown={this.props.markdown} />;
    return this.props.children;
  }
}

export function TabEditor(props: TabEditorProps) {
  return (
    <TabEditorBoundary markdown={props.markdown}>
      <MarkdownEditor {...props} />
    </TabEditorBoundary>
  );
}

/**
 * A TipTap editor over one tab's markdown. Mount it keyed by tab id. The
 * editor owns its content while the user types; a new `revision` means the
 * tab changed elsewhere and `markdown` replaces the content. Echoes of our own
 * saves do not bump the revision, so they never reset the caret.
 */
function MarkdownEditor(props: TabEditorProps) {
  const onChange = useRef(props.onChange);
  useLayoutEffect(() => {
    onChange.current = props.onChange;
  });
  const knownMarkdown = useRef(props.markdown);
  const images = useRef({
    upload: props.uploadImage,
    onUploadError: props.onUploadError,
    importLink: props.importImageLink,
  });
  // Fixed for the editor's life, like hasEmbeds below.
  const canImportLinks = useRef(props.importImageLink !== undefined).current;
  const onVideoFile = useRef(props.onVideoFile);
  const loadEmbed = useRef(props.loadEmbed);
  useLayoutEffect(() => {
    images.current = {
      upload: props.uploadImage,
      onUploadError: props.onUploadError,
      importLink: props.importImageLink,
    };
    onVideoFile.current = props.onVideoFile;
    loadEmbed.current = props.loadEmbed;
  });
  // Fixed for the editor's life: whether this doc has saved copies does not change.
  const hasEmbeds = useRef(props.loadEmbed !== undefined).current;

  const editor = useEditor({
    extensions: createEditorExtensions(
      {
        upload: (file) => images.current.upload(file),
        onUploadError: (error) => images.current.onUploadError(error),
        importLink: canImportLinks
          ? (url) =>
              images.current.importLink?.(url) ??
              Promise.reject(new Error("no imports"))
          : null,
      },
      {
        onFiles: (files, at) =>
          files.forEach((file) => onVideoFile.current(file, at)),
      },
      {
        load: hasEmbeds
          ? (url, refresh) =>
              loadEmbed.current?.(url, refresh) ??
              Promise.reject(new Error("no embeds"))
          : null,
      },
    ),
    editable: props.editable,
    content: props.markdown,
    contentType: "markdown",
    onUpdate: ({ editor: current, transaction }) => {
      if (transaction.getMeta(EXTERNAL_CONTENT_META)) return;
      const markdown = current.getMarkdown();
      knownMarkdown.current = markdown;
      onChange.current(markdown);
    },
  });

  useEffect(() => {
    if (editor.isEditable !== props.editable)
      editor.setEditable(props.editable, false);
  }, [editor, props.editable]);

  const { onEditor } = props;
  useEffect(() => {
    onEditor?.(editor);
    return () => onEditor?.(null);
  }, [editor, onEditor]);

  const latestMarkdown = useRef(props.markdown);
  const appliedRevision = useRef(props.revision);
  useLayoutEffect(() => {
    latestMarkdown.current = props.markdown;
  });
  useEffect(() => {
    if (props.revision === appliedRevision.current) return;
    appliedRevision.current = props.revision;
    if (latestMarkdown.current === knownMarkdown.current) return;
    knownMarkdown.current = latestMarkdown.current;
    editor
      .chain()
      .setMeta(EXTERNAL_CONTENT_META, true)
      .setContent(latestMarkdown.current, {
        contentType: "markdown",
        emitUpdate: false,
      })
      .run();
  }, [editor, props.revision]);

  return <EditorContent editor={editor} className="tab-editor" />;
}
