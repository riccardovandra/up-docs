export type DiagramRender =
  | { readonly status: "rendered"; readonly svg: string }
  | { readonly status: "error"; readonly message: string };

export interface DiagramCache {
  /** The finished render for this source, if there is one. */
  readonly peek: (source: string) => DiagramRender | undefined;
  readonly get: (source: string) => Promise<DiagramRender>;
}

/**
 * Renders each distinct diagram source once. Pele colors SVG through CSS
 * variables, so a render does not depend on the theme and the source alone is
 * the key. A DocRoom update replaces the whole tab, and the recreated node
 * views find their diagrams here instead of re-rendering them.
 *
 * Syntax errors are cached like diagrams. A rejected render means the renderer
 * failed to load, so it is reported but not kept, and the next view retries.
 */
export function createDiagramCache(
  render: (source: string) => Promise<DiagramRender>,
  capacity = 64,
): DiagramCache {
  const entries = new Map<
    string,
    { readonly pending: Promise<DiagramRender>; value?: DiagramRender }
  >();

  const touch = (source: string) => {
    const entry = entries.get(source);
    if (!entry) return undefined;
    entries.delete(source);
    entries.set(source, entry);
    return entry;
  };

  return {
    peek: (source) => touch(source)?.value,
    get: (source) => {
      const existing = touch(source);
      if (existing) return existing.pending;
      const pending = render(source).then(
        (value) => {
          if (entries.get(source) === entry) entry.value = value;
          return value;
        },
        (): DiagramRender => {
          if (entries.get(source) === entry) entries.delete(source);
          return { status: "error", message: "The diagram renderer failed to load." };
        },
      );
      const entry: { readonly pending: Promise<DiagramRender>; value?: DiagramRender } = {
        pending,
      };
      entries.set(source, entry);
      if (entries.size > capacity) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      return pending;
    },
  };
}
