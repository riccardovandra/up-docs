import { unsupportedMarkdownReason } from "../../host/docPaths.ts";
import type { LocalDocFile } from "../../host/docsCloudLocal.ts";

import type { LocalClient } from "./localClient.ts";

/** One body of markdown as its source last served it. */
export interface DocSnapshot {
  readonly markdown: string;
  /** Opaque; changes whenever the text does. */
  readonly version: string;
  /** Why it cannot be edited here, for the notice above it; null when it can. */
  readonly readOnlyReason: string | null;
}

export type DocSaveResult =
  | { readonly status: "saved"; readonly version: string }
  | { readonly status: "conflict"; readonly current: DocSnapshot };

/**
 * Where a page's markdown comes from and goes back to. Cloud tabs live in a
 * DocRoom (`useDocRoom`, `TabSaver`); a project file is served by the T3 Code
 * window framing this app. A save names the version it was based on, and a
 * source never overwrites text that changed since: it answers with a conflict.
 */
export interface DocSource {
  readonly load: () => Promise<DocSnapshot>;
  readonly save: (markdown: string, baseVersion: string) => Promise<DocSaveResult>;
  /** Called when the text may have changed elsewhere; the page reloads it. */
  readonly subscribe: (onChange: () => void) => () => void;
}

export function localSnapshot(file: LocalDocFile): DocSnapshot {
  const unsupported = unsupportedMarkdownReason(file.markdown);
  return {
    markdown: file.markdown,
    version: file.version,
    readOnlyReason:
      file.readOnlyReason ??
      (unsupported
        ? `This file uses ${unsupported}, which the editor cannot preserve, so it opens read-only. Ask the agent to edit it.`
        : null),
  };
}

/** A project file under `docs/`, read and written by the host over the embed bridge. */
export function localDocSource(client: LocalClient, path: string): DocSource {
  return {
    load: async () => localSnapshot(await client.request({ kind: "file.read", path })),
    save: async (markdown, baseVersion) => {
      const result = await client.request({ kind: "file.write", path, markdown, baseVersion });
      return result.status === "saved"
        ? result
        : { status: "conflict", current: localSnapshot(result.file) };
    },
    subscribe: client.onFilesChanged,
  };
}
