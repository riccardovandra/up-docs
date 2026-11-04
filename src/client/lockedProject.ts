import { useEffect, useState } from "react";

import { titleProjectKey } from "../shared/embed.ts";
import { api } from "./api.ts";
import { useEmbedProject } from "./embedContext.ts";

export type LockedProject =
  | { readonly kind: "open" }
  | { readonly kind: "loading" }
  | {
      readonly kind: "locked";
      readonly name: string;
      /** Null when the project has no docs here yet. */
      readonly projectId: string | null;
      readonly groups: ReadonlyArray<string>;
    };

/**
 * The project a locking parent keeps this frame in, resolved to its id so a
 * doc page can refuse docs from other projects. "open" outside such a parent.
 */
export function useLockedProject(): LockedProject {
  const project = useEmbedProject();
  const key = project?.locked === true ? (project.key ?? titleProjectKey(project.name)) : null;
  const [resolved, setResolved] = useState<{
    key: string;
    id: string | null;
  } | null>(null);

  useEffect(() => {
    if (key === null) return;
    let live = true;
    api.library().then(
      (library) => {
        if (live)
          setResolved({
            key,
            id: library.projects.find((p) => p.key === key)?.id ?? null,
          });
      },
      () => {
        if (live) setResolved({ key, id: null });
      },
    );
    return () => {
      live = false;
    };
  }, [key]);

  if (key === null || !project) return { kind: "open" };
  if (resolved?.key !== key) return { kind: "loading" };
  return {
    kind: "locked",
    name: project.name,
    projectId: resolved.id,
    groups: project.groups,
  };
}
