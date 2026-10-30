import type { LocalDocImport } from "../../host/docsCloudLocal.ts";

/** What a finished Move to UP Docs or Update tells the user. */
export function importNotice(result: LocalDocImport): string {
  if (result.status === "updated") return "UP Docs now has this file's current text.";
  if (result.status === "skipped") return "This file is already in UP Docs.";
  const parts = [
    result.commentsImported > 0
      ? `${result.commentsImported} ${result.commentsImported === 1 ? "comment" : "comments"} moved`
      : null,
    result.commentsSkipped > 0
      ? `${result.commentsSkipped} could not be placed because their text changed`
      : null,
  ].filter((part) => part !== null);
  return parts.length > 0
    ? `Moved to UP Docs: ${parts.join(", ")}. This file stays in the project.`
    : "Moved to UP Docs. This file stays in the project.";
}
