import { postToEmbedParent } from "../embedBridge.ts";
import { docPath } from "../router.ts";
import { readyWidgetsForPrint } from "../editor/widget/WidgetView.ts";

export const tabExportPath = (tabId: string) => `/api/tabs/${tabId}/export.md`;

export function download(path: string) {
  const link = document.createElement("a");
  link.href = path;
  link.download = "";
  link.click();
}

async function fetchMarkdown(path: string): Promise<string> {
  const response = await fetch(path, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

/** Copies an export route's Markdown, after `flush` lands pending edits. Call straight from a click. */
export async function copyMarkdown(flush: () => Promise<void>, path: string): Promise<void> {
  const markdown = flush().then(() => fetchMarkdown(path));
  // Handing the clipboard a promise keeps the click's user activation in
  // Safari, which rejects a write that starts after an await.
  if (typeof ClipboardItem !== "undefined") {
    const blob = markdown.then((text) => new Blob([text], { type: "text/plain" }));
    await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
  } else {
    await navigator.clipboard.writeText(await markdown);
  }
}

export interface ExportAction {
  readonly id: string;
  readonly label: string;
  /**
   * Must be called straight from the click: copying starts the clipboard
   * write before any await. Resolves to a short status, if any.
   */
  readonly run: () => Promise<string | null>;
}

/** The doc's export entries, for the title menu. */
export function exportActions(props: {
  readonly docId: string;
  readonly docTitle: string;
  readonly tabId: string | null;
  /** Saves the open tab's pending edit, so exports include it. */
  readonly flush: () => Promise<void>;
  /** Inside T3 Code, which can recreate the doc in Claude Docs. */
  readonly inT3Code: boolean;
}): ReadonlyArray<ExportAction> {
  const { docId, tabId, flush } = props;
  const actions: Array<ExportAction> = [];
  if (tabId) {
    actions.push(
      {
        id: "download-tab",
        label: "Download tab as Markdown",
        run: async () => {
          await flush();
          download(tabExportPath(tabId));
          return null;
        },
      },
      {
        id: "copy-tab",
        label: "Copy tab as Markdown",
        run: async () => {
          await copyMarkdown(flush, tabExportPath(tabId));
          return "Copied the tab as Markdown.";
        },
      },
    );
  }
  actions.push(
    {
      id: "download-doc",
      label: "Download doc as Markdown",
      run: async () => {
        await flush();
        download(`/api/docs/${docId}/export.md`);
        return null;
      },
    },
    {
      id: "download-doc-docx",
      label: "Download doc as Word",
      run: async () => {
        await flush();
        download(`/api/docs/${docId}/export.docx`);
        return null;
      },
    },
    {
      id: "print",
      label: "Print / Save as PDF",
      run: async () => {
        await readyWidgetsForPrint();
        window.print();
        return null;
      },
    },
  );
  if (props.inT3Code) {
    actions.push({
      id: "copy-to-claude-doc",
      label: "Copy to Claude Doc…",
      run: async () => {
        // The agent reads the doc from the server, so pending edits go first.
        await flush();
        postToEmbedParent({
          type: "t3-docs:copy-to-claude-doc",
          docId,
          title: props.docTitle,
          url: `${window.location.origin}${docPath(docId)}`,
        });
        return null;
      },
    });
  }
  return actions;
}
