import type { CSSProperties } from "react";

import { ChevronDownIcon, FolderIcon } from "./icons.tsx";
import {
  ALL_PROJECTS,
  NO_PROJECT,
  projectMonogram,
  sameScope,
  type ProjectScope,
} from "./homeLogic.ts";
import { Menu, MenuItem, MenuSeparator } from "./Menu.tsx";

/** A project the switcher lists: one in the library, or the T3 Code project not synced yet. */
export interface SwitcherProject {
  readonly key: string;
  readonly name: string;
}

/** T3 Code's initials badge for a project. */
export function ProjectBadge(props: { readonly name: string }) {
  const monogram = projectMonogram(props.name);
  const style = { "--mono-light": monogram.light, "--mono-dark": monogram.dark } as CSSProperties;
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="project-badge" style={style}>
      <text
        x="8"
        y="10.8"
        textAnchor="middle"
        fill="currentColor"
        fontSize="8.25"
        fontWeight="700"
        textLength={Array.from(monogram.text).length === 1 ? 6 : 12}
        lengthAdjust="spacingAndGlyphs"
      >
        {monogram.text}
      </text>
    </svg>
  );
}

/** T3 Code's dashed tile for "No project". */
export const NoProjectBadge = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" className="project-badge no-project">
    <rect x="1.5" y="1.5" width="13" height="13" rx="3.5" />
  </svg>
);

export function scopeName(scope: ProjectScope, projects: ReadonlyArray<SwitcherProject>): string {
  if (scope.kind === "all") return "All projects";
  if (scope.kind === "none") return "No project";
  return projects.find((project) => project.key === scope.key)?.name ?? "Project";
}

function ScopeIcon(props: { scope: ProjectScope; name: string }) {
  if (props.scope.kind === "all") return <FolderIcon size={15} />;
  if (props.scope.kind === "none") return <NoProjectBadge />;
  return <ProjectBadge name={props.name} />;
}

/** Filters the home page by project; it never navigates. */
export function ProjectSwitcher(props: {
  readonly scope: ProjectScope;
  readonly projects: ReadonlyArray<SwitcherProject>;
  readonly onChange: (scope: ProjectScope) => void;
}) {
  const name = scopeName(props.scope, props.projects);
  const pick = (scope: ProjectScope, close: () => void) => {
    props.onChange(scope);
    close();
  };
  return (
    <Menu
      label="Project"
      align="start"
      triggerClassName="project-switcher"
      trigger={
        <>
          <ScopeIcon scope={props.scope} name={name} />
          <span className="project-switcher-name">{name}</span>
          <ChevronDownIcon size={14} />
        </>
      }
    >
      {(close) => (
        <>
          <MenuItem
            kind="radio"
            checked={sameScope(props.scope, ALL_PROJECTS)}
            icon={<FolderIcon size={15} />}
            onSelect={() => pick(ALL_PROJECTS, close)}
          >
            All projects
          </MenuItem>
          {props.projects.length > 0 ? <MenuSeparator /> : null}
          <div className="home-menu-scroll">
            {props.projects.map((project) => {
              const scope: ProjectScope = { kind: "project", key: project.key };
              return (
                <MenuItem
                  key={project.key}
                  kind="radio"
                  checked={sameScope(props.scope, scope)}
                  icon={<ProjectBadge name={project.name} />}
                  onSelect={() => pick(scope, close)}
                >
                  {project.name}
                </MenuItem>
              );
            })}
          </div>
          <MenuSeparator />
          <MenuItem
            kind="radio"
            checked={sameScope(props.scope, NO_PROJECT)}
            icon={<NoProjectBadge />}
            onSelect={() => pick(NO_PROJECT, close)}
          >
            No project
          </MenuItem>
        </>
      )}
    </Menu>
  );
}
