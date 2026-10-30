import { useCallback, useEffect, useState } from "react";

import { docPath, navigate } from "../router.ts";
import { hostClient } from "./hostClient.ts";
import { importNotice } from "./importNotice.ts";
import { LocalRequestError } from "./localClient.ts";

/**
 * "Move to UP Docs" for a project file, or, once it is there, "Open in
 * UP Docs" and "Update" (copy the file's current text again). The file
 * itself stays in the project either way.
 */
export function LocalImportActions(props: {
  readonly path: string;
  /** Saves pending edits first, since the T3 server copies the file from disk. */
  readonly beforeImport: () => Promise<void>;
  readonly onNotice: (notice: string) => void;
}) {
  const { path, onNotice } = props;
  // undefined until the host has said whether the file was imported.
  const [cloudDocId, setCloudDocId] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const { files } = await hostClient.request({ kind: "files.list" });
      setCloudDocId(files.find((file) => file.path === path)?.cloudDocId ?? null);
    } catch {
      setCloudDocId(null);
    }
  }, [path]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (update: boolean) => {
    setBusy(true);
    try {
      await props.beforeImport();
      const result = await hostClient.request({ kind: "file.import", path, update });
      setCloudDocId(result.cloudDocId);
      onNotice(importNotice(result));
    } catch (cause) {
      onNotice(
        cause instanceof LocalRequestError
          ? `Could not move this file to UP Docs: ${cause.message}`
          : "Could not move this file to UP Docs. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  if (cloudDocId === undefined) return null;
  if (cloudDocId === null) {
    return (
      <button
        type="button"
        className="local-import-button"
        disabled={busy}
        onClick={() => void run(false)}
      >
        {busy ? "Moving…" : "Move to UP Docs"}
      </button>
    );
  }
  return (
    <>
      <button
        type="button"
        className="local-import-button"
        onClick={() => navigate(docPath(cloudDocId))}
      >
        Open in UP Docs
      </button>
      <button
        type="button"
        className="local-import-button"
        disabled={busy}
        aria-label="Update the UP Docs doc with this file's current text"
        onClick={() => void run(true)}
      >
        {busy ? "Updating…" : "Update"}
      </button>
    </>
  );
}
