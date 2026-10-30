import { useEffect, useState } from "react";

import { api } from "../../api.ts";
import { MenuItem, MenuLabel } from "../toolbar/Popover.tsx";

/** The title menu's project list: "No project" plus every project the reader can see. */
export function MoveToProject(props: {
  readonly projectId: string | null;
  readonly onMove: (projectId: string | null) => void;
}) {
  const [projects, setProjects] = useState<ReadonlyArray<{ id: string; name: string }> | null>(
    null,
  );
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    api.library().then(
      (library) => {
        if (live) setProjects(library.projects.map(({ id, name }) => ({ id, name })));
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const move = (projectId: string | null) => {
    if (projectId !== props.projectId) props.onMove(projectId);
  };

  if (failed) return <MenuLabel>Could not load projects.</MenuLabel>;
  if (!projects) return <MenuLabel>Loading projects…</MenuLabel>;
  return (
    <>
      <MenuItem label="No project" checked={props.projectId === null} onSelect={() => move(null)} />
      {projects.map((project) => (
        <MenuItem
          key={project.id}
          label={project.name}
          checked={project.id === props.projectId}
          onSelect={() => move(project.id)}
        />
      ))}
    </>
  );
}
