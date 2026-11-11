import { useEffect, useId, useState } from "react";

import { restyleDiagram, type DiagramTheme } from "../../shared/diagramTheme.ts";
import {
  previewModel,
  SAMPLE_SIZE,
  THEME_SAMPLE_XML,
  themeFontUrls,
  type PreviewBox,
  type PreviewModel,
} from "./themeEditor.ts";

/** Adds the Google font stylesheets the preview draws with, once each, to the page. */
function useFontLinks(urls: ReadonlyArray<string>) {
  const key = urls.join(" ");
  useEffect(() => {
    for (const url of key === "" ? [] : key.split(" ")) {
      if (document.head.querySelector(`link[data-theme-font="${CSS.escape(url)}"]`)) continue;
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = url;
      link.dataset.themeFont = url;
      document.head.append(link);
    }
  }, [key]);
}

const family = (name: string) => `"${name}", Helvetica, Arial, sans-serif`;

const ARROWS: Readonly<Record<string, string>> = {
  block: "M0,0 L10,5 L0,10 Z",
  classic: "M0,0 L10,5 L0,10 L3,5 Z",
  blockThin: "M0,1.5 L10,5 L0,8.5 Z",
  open: "M0,0 L10,5 L0,10",
};

function Box(props: { readonly box: PreviewBox; readonly shadow: string }) {
  const { box } = props;
  const filter = box.shadow ? `url(#${props.shadow})` : undefined;
  const text = {
    fill: box.fontColor,
    fontFamily: family(box.fontFamily),
    fontSize: box.fontSize,
    textAnchor: "middle" as const,
    dominantBaseline: "central" as const,
  };
  if (box.header !== null) {
    return (
      <g filter={filter}>
        <rect
          x={box.x}
          y={box.y}
          width={box.width}
          height={box.height}
          rx={box.radius}
          fill="none"
          stroke={box.stroke}
          strokeWidth={box.strokeWidth}
        />
        <path
          d={`M${box.x},${box.y + box.header} V${box.y + box.radius} Q${box.x},${box.y} ${box.x + box.radius},${box.y} H${box.x + box.width - box.radius} Q${box.x + box.width},${box.y} ${box.x + box.width},${box.y + box.radius} V${box.y + box.header} Z`}
          fill={box.fill}
          stroke={box.stroke}
          strokeWidth={box.strokeWidth}
        />
        <text x={box.x + box.width / 2} y={box.y + box.header / 2} {...text} fontWeight={700}>
          {box.label}
        </text>
      </g>
    );
  }
  return (
    <g filter={filter}>
      <rect
        x={box.x}
        y={box.y}
        width={box.width}
        height={box.height}
        rx={box.radius}
        fill={box.fill}
        stroke={box.stroke}
        strokeWidth={box.strokeWidth}
      />
      <text x={box.x + box.width / 2} y={box.y + box.height / 2} {...text}>
        {box.label}
      </text>
    </g>
  );
}

/** Draws the preview model: boxes, the container, and arrows with their heads and labels. */
export function PreviewDrawing(props: { readonly model: PreviewModel; readonly label: string }) {
  const { model } = props;
  const id = useId().replace(/:/g, "");
  const shadow = `${id}-shadow`;
  const marker = (edgeId: string) => `${id}-arrow-${edgeId}`;
  return (
    <svg
      className="theme-preview-svg"
      viewBox={`0 0 ${SAMPLE_SIZE.width} ${SAMPLE_SIZE.height}`}
      role="img"
      aria-label={props.label}
      style={{ background: model.background }}
    >
      <defs>
        <filter id={shadow} x="-10%" y="-10%" width="130%" height="140%">
          <feDropShadow dx="2" dy="3" stdDeviation="2" floodOpacity="0.25" />
        </filter>
        {model.edges.map((edge) => (
          <marker
            key={edge.id}
            id={marker(edge.id)}
            viewBox="-1 -1 12 12"
            refX="10"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            markerUnits="userSpaceOnUse"
            orient="auto-start-reverse"
            style={{ overflow: "visible" }}
          >
            {edge.arrow === "oval" ? (
              <circle cx="5" cy="5" r="4" fill={edge.stroke} />
            ) : edge.arrow === "none" ? null : (
              <path
                d={ARROWS[edge.arrow] ?? ARROWS.classic}
                fill={edge.arrow === "open" ? "none" : edge.stroke}
                stroke={edge.stroke}
                strokeWidth={1.2}
              />
            )}
          </marker>
        ))}
      </defs>
      {model.boxes
        .filter((box) => box.header !== null)
        .map((box) => (
          <Box key={box.id} box={box} shadow={shadow} />
        ))}
      {model.edges.map((edge) => (
        <g key={edge.id}>
          <path
            d={edge.path}
            fill="none"
            stroke={edge.stroke}
            strokeWidth={edge.strokeWidth}
            markerEnd={`url(#${marker(edge.id)})`}
          />
          {edge.label ? (
            <text
              x={edge.labelAt.x}
              y={edge.labelAt.y - 4}
              fill={edge.fontColor}
              fontFamily={family(edge.fontFamily)}
              fontSize={edge.fontSize}
              textAnchor="middle"
              paintOrder="stroke"
              stroke={model.background}
              strokeWidth={4}
            >
              {edge.label}
            </text>
          ) : null}
        </g>
      ))}
      {model.boxes
        .filter((box) => box.header === null)
        .map((box) => (
          <Box key={box.id} box={box} shadow={shadow} />
        ))}
    </svg>
  );
}

/**
 * The live preview: the sample diagram restyled to `theme` in the browser,
 * drawn again on every change. Draw.io's own drawing differs in detail; the
 * colours, fonts, corners, lines and arrows are the theme's.
 */
export function ThemePreview(props: { readonly theme: DiagramTheme }) {
  const { theme } = props;
  const [model, setModel] = useState<PreviewModel | null>(null);
  useFontLinks(themeFontUrls(theme.tokens));
  useEffect(() => {
    let live = true;
    void restyleDiagram(THEME_SAMPLE_XML, theme).then((result) => {
      if (live && result.ok) setModel(previewModel(result.xml));
    });
    return () => {
      live = false;
    };
  }, [theme]);
  return (
    <div className="theme-preview">
      {model ? <PreviewDrawing model={model} label={`Sample diagram in ${theme.name}`} /> : null}
    </div>
  );
}
