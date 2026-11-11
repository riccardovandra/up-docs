import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import {
  DIAGRAM_ARROW_HEADS,
  DIAGRAM_EDGE_STYLES,
  DIAGRAM_THEME_LIMITS,
  DIAGRAM_THEME_ROLES,
  type CustomDiagramTheme,
  type DiagramFont,
  type DiagramTheme,
  type DiagramThemeList,
  type DiagramThemeTokens,
} from "../../shared/diagramTheme.ts";
import type { Project } from "../../shared/protocol.ts";
import { api, ApiError } from "../api.ts";
import { ThemePreview } from "../diagrams/ThemePreview.tsx";
import {
  blankDraft,
  checkDraft,
  colourInputValue,
  draftOf,
  duplicateDraft,
  fontOf,
  isChanged,
  ROLE_NAMES,
  setCanvas,
  setFont,
  setName,
  setRoleColour,
  setToken,
  themeRowActions,
  WEB_SAFE_FONTS,
  type ThemeDraft,
  type ThemeRowAction,
} from "../diagrams/themeEditor.ts";
import { themesApi } from "../diagrams/themesApi.ts";
import "../diagrams/diagrams.css";

const EDGE_LABELS: Readonly<Record<DiagramThemeTokens["edgeStyle"], string>> = {
  orthogonal: "Right angles",
  curved: "Curved",
  straight: "Straight",
};

const ARROW_LABELS: Readonly<Record<DiagramThemeTokens["arrowHead"], string>> = {
  block: "Filled triangle",
  classic: "Classic",
  open: "Open",
  blockThin: "Thin triangle",
  oval: "Dot",
};

const problemOf = (cause: unknown) => {
  if (cause instanceof ApiError) {
    const message = (cause.body as { readonly message?: unknown }).message;
    if (typeof message === "string" && message !== "") return message;
    if (cause.body.error === "theme_limit") return "The workspace has reached the most custom themes it can keep.";
    if (cause.body.error === "admin_only") return "Only the admin changes diagram themes.";
  }
  return "That did not work. Check your connection and try again.";
};

function ColourField(props: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <span className="theme-colour">
      <input
        type="color"
        aria-label={`${props.label} colour`}
        value={colourInputValue(props.value)}
        onChange={(event) => props.onChange(event.target.value)}
      />
      <input
        type="text"
        aria-label={`${props.label} hex`}
        spellCheck={false}
        maxLength={7}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value.trim())}
      />
    </span>
  );
}

const GOOGLE = "__google__";

function FontField(props: {
  readonly label: string;
  readonly value: DiagramFont;
  readonly onChange: (font: DiagramFont) => void;
}) {
  const { value } = props;
  const google = value.url !== null;
  const listed = (WEB_SAFE_FONTS as ReadonlyArray<string>).includes(value.family);
  return (
    <label className="theme-field">
      <span>{props.label}</span>
      <span className="theme-font">
        <select
          aria-label={`${props.label} source`}
          value={google ? GOOGLE : value.family}
          onChange={(event) =>
            props.onChange(
              event.target.value === GOOGLE
                ? fontOf(google ? value.family : "Inter", true)
                : fontOf(event.target.value, false),
            )
          }
        >
          {WEB_SAFE_FONTS.map((font) => (
            <option key={font} value={font}>
              {font}
            </option>
          ))}
          {!google && !listed ? <option value={value.family}>{value.family}</option> : null}
          <option value={GOOGLE}>Google font…</option>
        </select>
        {google ? (
          <input
            type="text"
            aria-label={`${props.label} Google family`}
            placeholder="Google font family, e.g. Inter"
            maxLength={60}
            value={value.family}
            onChange={(event) => props.onChange({ family: event.target.value, url: fontOf(event.target.value, true).url })}
          />
        ) : null}
      </span>
    </label>
  );
}

function NumberField(props: {
  readonly label: string;
  readonly value: number;
  readonly limits: { readonly min: number; readonly max: number };
  readonly step: number;
  readonly onChange: (value: number) => void;
}) {
  return (
    <label className="theme-field">
      <span>{props.label}</span>
      <input
        type="number"
        min={props.limits.min}
        max={props.limits.max}
        step={props.step}
        value={Number.isNaN(props.value) ? "" : props.value}
        onChange={(event) =>
          props.onChange(event.target.value === "" ? Number.NaN : Number(event.target.value))
        }
      />
    </label>
  );
}

const swatches = (theme: DiagramTheme) => (
  <span className="theme-swatches" aria-hidden="true">
    {DIAGRAM_THEME_ROLES.map((role) => (
      <span
        key={role}
        style={{
          background: theme.tokens.roles[role].fill,
          borderColor: theme.tokens.roles[role].stroke,
        }}
      />
    ))}
  </span>
);

/** One theme open in the editor: a new one, a copy, a custom one to change, or one to look at. */
type Open =
  | { readonly kind: "new" | "edit"; readonly themeId: string | null; readonly saved: ThemeDraft }
  | { readonly kind: "view"; readonly theme: DiagramTheme };

function ThemeEditor(props: {
  readonly open: Open;
  readonly admin: boolean;
  readonly onSaved: (theme: CustomDiagramTheme) => void;
  readonly onClose: () => void;
  readonly onDuplicate: (theme: DiagramTheme) => void;
}) {
  const { open } = props;
  const readOnly = open.kind === "view";
  const start = open.kind === "view" ? draftOf(open.theme) : open.saved;
  const [draft, setDraft] = useState<ThemeDraft>(start);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const check = checkDraft(draft);
  // The preview keeps the last theme that checked while a field is half typed.
  const lastGood = useRef(JSON.stringify({ name: start.name, tokens: start.tokens }));
  if (check.ok) lastGood.current = JSON.stringify(check.value);
  const shown = lastGood.current;
  const previewTheme = useMemo<DiagramTheme>(() => {
    const value = JSON.parse(shown) as ThemeDraft;
    return { id: "preview", name: value.name, builtIn: false, tokens: value.tokens };
  }, [shown]);
  const changed = open.kind === "new" || isChanged(draft, start);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (readOnly || !check.ok || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const theme =
        open.kind === "edit" && open.themeId !== null
          ? await themesApi.update(open.themeId, check.value)
          : await themesApi.create(check.value);
      props.onSaved(theme);
    } catch (cause) {
      setProblem(problemOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const { tokens } = draft;
  const update = (next: ThemeDraft) => setDraft(next);
  return (
    <form className="theme-editor" onSubmit={save} aria-label="Theme editor">
      <div className="theme-editor-form">
        <fieldset disabled={readOnly || busy}>
          <label className="theme-field theme-name">
            <span>Name</span>
            <input
              value={draft.name}
              maxLength={80}
              onChange={(event) => update(setName(draft, event.target.value))}
            />
          </label>
          <table className="theme-roles">
            <thead>
              <tr>
                <th scope="col">Role</th>
                <th scope="col">Fill</th>
                <th scope="col">Line</th>
                <th scope="col">Text</th>
                <th scope="col" title="The role a new box takes">
                  Default
                </th>
              </tr>
            </thead>
            <tbody>
              {DIAGRAM_THEME_ROLES.map((role) => (
                <tr key={role}>
                  <th scope="row">{ROLE_NAMES[role]}</th>
                  {(["fill", "stroke", "font"] as const).map((part) => (
                    <td key={part}>
                      <ColourField
                        label={`${ROLE_NAMES[role]} ${part === "stroke" ? "line" : part === "font" ? "text" : part}`}
                        value={tokens.roles[role][part]}
                        onChange={(value) => update(setRoleColour(draft, role, part, value))}
                      />
                    </td>
                  ))}
                  <td>
                    <input
                      type="radio"
                      name="default-role"
                      aria-label={`${ROLE_NAMES[role]} is the default role`}
                      checked={tokens.defaultRole === role}
                      onChange={() => update(setToken(draft, "defaultRole", role))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="theme-fields">
            <label className="theme-field">
              <span>Canvas</span>
              <ColourField
                label="Canvas background"
                value={tokens.canvas.background}
                onChange={(value) => update(setCanvas(draft, "background", value))}
              />
            </label>
            <label className="theme-field">
              <span>Words and arrow labels</span>
              <ColourField
                label="Canvas text"
                value={tokens.canvas.text}
                onChange={(value) => update(setCanvas(draft, "text", value))}
              />
            </label>
            <FontField
              label="Body font"
              value={tokens.font}
              onChange={(font) => update(setFont(draft, "font", font))}
            />
            <FontField
              label="Title font"
              value={tokens.titleFont}
              onChange={(font) => update(setFont(draft, "titleFont", font))}
            />
            <NumberField
              label="Text size (px)"
              value={tokens.fontSize}
              limits={DIAGRAM_THEME_LIMITS.fontSize}
              step={1}
              onChange={(value) => update(setToken(draft, "fontSize", value))}
            />
            <NumberField
              label="Corner radius (px)"
              value={tokens.cornerRadius}
              limits={DIAGRAM_THEME_LIMITS.cornerRadius}
              step={1}
              onChange={(value) => update(setToken(draft, "cornerRadius", value))}
            />
            <NumberField
              label="Line width (px)"
              value={tokens.strokeWidth}
              limits={DIAGRAM_THEME_LIMITS.strokeWidth}
              step={0.5}
              onChange={(value) => update(setToken(draft, "strokeWidth", value))}
            />
            <label className="theme-field">
              <span>Arrows</span>
              <select
                value={tokens.edgeStyle}
                onChange={(event) =>
                  update(setToken(draft, "edgeStyle", event.target.value as DiagramThemeTokens["edgeStyle"]))
                }
              >
                {DIAGRAM_EDGE_STYLES.map((style) => (
                  <option key={style} value={style}>
                    {EDGE_LABELS[style]}
                  </option>
                ))}
              </select>
            </label>
            <label className="theme-field">
              <span>Arrow head</span>
              <select
                value={tokens.arrowHead}
                onChange={(event) =>
                  update(setToken(draft, "arrowHead", event.target.value as DiagramThemeTokens["arrowHead"]))
                }
              >
                {DIAGRAM_ARROW_HEADS.map((head) => (
                  <option key={head} value={head}>
                    {ARROW_LABELS[head]}
                  </option>
                ))}
              </select>
            </label>
            <label className="theme-field theme-check">
              <input
                type="checkbox"
                checked={tokens.shadow}
                onChange={(event) => update(setToken(draft, "shadow", event.target.checked))}
              />
              <span>Shadow</span>
            </label>
          </div>
        </fieldset>
        {!check.ok && !readOnly ? (
          <p className="error" role="alert">
            {check.error}
          </p>
        ) : null}
        {problem ? (
          <p className="error" role="alert">
            {problem}
          </p>
        ) : null}
        <div className="theme-editor-actions">
          {readOnly ? (
            <>
              <span className="muted">
                {props.admin
                  ? "Built-in themes cannot be changed."
                  : "Only the admin changes themes. You can use any of them on your diagrams."}
              </span>
              <button type="button" className="button secondary" onClick={props.onClose}>
                Close
              </button>
              {props.admin ? (
                <button type="button" className="button" onClick={() => props.onDuplicate(open.theme)}>
                  Duplicate to change
                </button>
              ) : null}
            </>
          ) : (
            <>
              <button type="button" className="button secondary" onClick={props.onClose}>
                Cancel
              </button>
              <button type="submit" className="button" disabled={!check.ok || !changed || busy}>
                {busy ? "Saving…" : open.kind === "new" ? "Create theme" : "Save theme"}
              </button>
            </>
          )}
        </div>
      </div>
      <div className="theme-editor-preview">
        <h3>Preview</h3>
        <ThemePreview theme={previewTheme} />
        <p className="muted">
          A sample diagram restyled to this theme. New shapes in Draw.io start this way, and
          Restyle with theme turns an existing diagram into it.
        </p>
      </div>
    </form>
  );
}

const ACTION_LABELS: Readonly<Record<ThemeRowAction, string>> = {
  view: "View",
  edit: "Edit",
  duplicate: "Duplicate",
  delete: "Delete",
};

const NO_THEME = "";

/** The admin picks a project's default theme: the one its new and unset diagrams use. */
function ProjectDefaults(props: { readonly themes: ReadonlyArray<DiagramTheme> }) {
  const [projects, setProjects] = useState<ReadonlyArray<Project> | null>(null);
  const [projectId, setProjectId] = useState<string>("");
  const [current, setCurrent] = useState<string | null | undefined>(undefined);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    api.library().then(
      (library) => setProjects([...library.projects].sort((a, b) => a.name.localeCompare(b.name))),
      () => setProjects([]),
    );
  }, []);

  useEffect(() => {
    setCurrent(undefined);
    setStatus(null);
    if (projectId === "") return;
    let live = true;
    themesApi.projectTheme(projectId).then(
      (effective) => {
        if (live) setCurrent(effective.projectThemeId);
      },
      (cause) => {
        if (live) setStatus(problemOf(cause));
      },
    );
    return () => {
      live = false;
    };
  }, [projectId]);

  if (!projects) return null;
  if (projects.length === 0) return <p className="muted">No projects yet.</p>;

  const choose = async (themeId: string | null) => {
    setStatus(null);
    try {
      const effective = await themesApi.setProjectTheme(projectId, themeId);
      setCurrent(effective.projectThemeId);
      const name = projects.find((project) => project.id === projectId)?.name ?? "The project";
      setStatus(`${name} now uses ${effective.theme.name} for new diagrams and those that follow it.`);
    } catch (cause) {
      setStatus(problemOf(cause));
    }
  };

  return (
    <div className="theme-project">
      <label className="theme-field">
        <span>Project</span>
        <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
          <option value="">Choose a project…</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      <label className="theme-field">
        <span>Default theme</span>
        <select
          disabled={projectId === "" || current === undefined}
          value={current ?? NO_THEME}
          onChange={(event) => void choose(event.target.value === NO_THEME ? null : event.target.value)}
        >
          <option value={NO_THEME}>None (Neutral)</option>
          {props.themes.map((theme) => (
            <option key={theme.id} value={theme.id}>
              {theme.name}
            </option>
          ))}
        </select>
      </label>
      {status ? (
        <p className="muted" role="status">
          {status}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Settings, Diagram themes: the built-ins and the workspace's custom themes.
 * The admin gets the editor with a live preview and each project's default;
 * everyone else views the themes read-only.
 */
export function DiagramThemeSettings(props: { readonly admin: boolean }) {
  const [list, setList] = useState<DiagramThemeList | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<Open | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const editor = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    try {
      setList(await themesApi.list());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (open) editor.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [open]);

  if (failed) {
    return (
      <p className="error">
        Could not load the diagram themes.{" "}
        <button type="button" className="link-button" onClick={() => void reload()}>
          Try again
        </button>
      </p>
    );
  }
  if (!list) return <p className="muted">Loading themes…</p>;

  const names = list.themes.map((theme) => theme.name);
  const duplicate = (theme: DiagramTheme) =>
    setOpen({ kind: "new", themeId: null, saved: duplicateDraft(theme, names) });

  const remove = async (theme: DiagramTheme) => {
    if (
      !window.confirm(
        `Delete the theme "${theme.name}"? Diagrams and projects that use it go back to their ` +
          "project's theme, or Neutral. Their drawings keep the colours they have.",
      )
    ) {
      return;
    }
    try {
      await themesApi.remove(theme.id);
      if (open && open.kind === "edit" && open.themeId === theme.id) setOpen(null);
      setNotice(`Deleted "${theme.name}".`);
      await reload();
    } catch (cause) {
      setNotice(problemOf(cause));
    }
  };

  return (
    <div className="theme-settings">
      <ul className="theme-list">
        {list.themes.map((theme) => (
          <li key={theme.id} className="theme-row">
            {swatches(theme)}
            <span className="theme-row-name">
              {theme.name}
              <span className="muted">
                {theme.builtIn
                  ? theme.id === list.defaultThemeId
                    ? "Built-in, the default"
                    : "Built-in"
                  : "Custom"}
              </span>
            </span>
            <span className="theme-row-actions">
              {themeRowActions(theme, props.admin).map((action) => (
                <button
                  key={action}
                  type="button"
                  className={action === "delete" ? "link-button danger" : "link-button"}
                  onClick={() => {
                    if (action === "view") setOpen({ kind: "view", theme });
                    else if (action === "edit")
                      setOpen({ kind: "edit", themeId: theme.id, saved: draftOf(theme) });
                    else if (action === "duplicate") duplicate(theme);
                    else void remove(theme);
                  }}
                >
                  {ACTION_LABELS[action]}
                </button>
              ))}
            </span>
          </li>
        ))}
      </ul>
      {props.admin ? (
        <div className="inline-form">
          <button
            type="button"
            className="button secondary"
            onClick={() => setOpen({ kind: "new", themeId: null, saved: blankDraft(names) })}
          >
            New theme
          </button>
          {notice ? (
            <span className="muted" role="status">
              {notice}
            </span>
          ) : null}
        </div>
      ) : null}
      <div ref={editor}>
        {open ? (
          <ThemeEditor
            key={open.kind === "view" ? `view-${open.theme.id}` : `${open.kind}-${open.themeId ?? open.saved.name}`}
            open={open}
            admin={props.admin}
            onClose={() => setOpen(null)}
            onDuplicate={duplicate}
            onSaved={(theme) => {
              setNotice(`Saved "${theme.name}".`);
              setOpen({ kind: "edit", themeId: theme.id, saved: draftOf(theme) });
              void reload();
            }}
          />
        ) : null}
      </div>
      {props.admin ? (
        <>
          <h3>Project defaults</h3>
          <p className="muted">
            A project&apos;s diagrams use its default theme unless a diagram picks its own. With
            none set, they use Neutral.
          </p>
          <ProjectDefaults themes={list.themes} />
        </>
      ) : null}
    </div>
  );
}
