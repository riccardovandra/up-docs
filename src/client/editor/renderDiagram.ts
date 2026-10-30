import { createDiagramCache, type DiagramRender } from "./diagramCache.ts";

type Renderer = {
  readonly pele: typeof import("pele/lazy");
  readonly purify: ReturnType<typeof import("dompurify").default>;
};

let rendererLoad: Promise<Renderer> | null = null;

// Pele and its per-type parsers are separate chunks, fetched the first time a
// tab contains a diagram.
function loadRenderer(): Promise<Renderer> {
  rendererLoad ??= Promise.all([import("pele/lazy"), import("dompurify")]).then(
    ([pele, { default: DOMPurify }]) => ({ pele, purify: DOMPurify(window) }),
    (error: unknown) => {
      rendererLoad = null;
      throw error;
    },
  );
  return rendererLoad;
}

// Pele names markers and gradients `${idPrefix}-…`. Diagrams sharing a page
// need distinct prefixes; identical sources may share one.
function idPrefix(source: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index++) {
    hash = Math.imul(hash ^ source.charCodeAt(index), 0x01000193);
  }
  return `dg${(hash >>> 0).toString(36)}`;
}

async function renderDiagram(source: string): Promise<DiagramRender> {
  const { pele, purify } = await loadRenderer();
  let svg: string;
  try {
    ({ svg } = await pele.renderAsync(source, {
      idPrefix: idPrefix(source),
      fontFamily: getComputedStyle(document.body).fontFamily,
      links: false,
      images: false,
      // Keep the author's direction; a wide diagram scales down instead.
      autoDirection: false,
    }));
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "The diagram could not be rendered.",
    };
  }
  // Pele escapes labels and links and images are off. This is the strict
  // policy on top: nothing that navigates, runs script, or fetches.
  return {
    status: "rendered",
    svg: purify.sanitize(svg, {
      FORBID_ATTR: ["href", "xlink:href", "src", "srcset"],
      FORBID_TAGS: ["a", "image", "foreignObject", "style"],
      USE_PROFILES: { svg: true, svgFilters: true },
    }),
  };
}

export const diagramCache = createDiagramCache((source) => renderDiagram(source));
