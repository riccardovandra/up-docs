import { describe, expect, it } from "vitest";

import { FLOW_EXAMPLE, PILLARS_EXAMPLE } from "./testing/examples.ts";
import { analyzeWidget, type WidgetRule } from "./validate.ts";

const svg = (body: string, head = "") =>
  `${head}export default () => <svg viewBox='0 0 760 120' role='img' aria-label='T'>${body}</svg>;`;
const title = `<text data-claude-text-id='title' x='24' y='28' fill='var(--cds-text-primary)'>Title</text>`;

describe("analyzeWidget", () => {
  it.each([
    ["the flow example", FLOW_EXAMPLE, 11, "Only a green build reaches production"],
    [
      "the pillars example",
      PILLARS_EXAMPLE,
      15,
      "Three pillars carry the goal of doubling active teams",
    ],
  ])("accepts %s and lists its labels", (_, source, labels, expectedTitle) => {
    const analysis = analyzeWidget(source);
    expect(analysis.diagnostics).toEqual([]);
    expect(analysis.labels).toHaveLength(labels);
    expect(analysis.title).toBe(expectedTitle);
    expect(analysis.viewBox?.width).toBe(760);
  });

  it("records each label's words and the anchor it sits in", () => {
    const analysis = analyzeWidget(FLOW_EXAMPLE);
    expect(analysis.labels.find((label) => label.id === "ship")).toMatchObject({
      text: "Ship to production",
      anchor: "step-ship",
    });
    expect(analysis.anchors).toContain("decision-tests");
  });

  it("accepts tspans with one id per line, helpers, components and literal indexes", () => {
    const source = svg(
      `${title}<text x='0' y='60' fill='var(--cds-text-primary)'><tspan data-claude-text-id='l1'>One</tspan><tspan data-claude-text-id='l2'>Two</tspan></text>{[0, 1].map(i => <Dot key={i} x={xs.at(i)} />)}<g data-claude-anchor={\`lane-\${xs[0]}\`} />`,
      "const xs = [1, 2]; const Dot = ({x}) => <circle cx={x} cy='5' r='2' fill='var(--cds-chart-axis)'/>;\n",
    );
    expect(analyzeWidget(source).diagnostics).toEqual([]);
  });

  const refused: ReadonlyArray<[WidgetRule | "parse", string]> = [
    ["parse", svg("<g>")],
    ["module-shape", `import x from 'y';\n${svg(title)}`],
    ["module-shape", "const a = 1;"],
    ["svg-root", "export default () => <g />;"],
    [
      "svg-root",
      "export default () => <svg viewBox={w}><text data-claude-text-id='t' fill='none'>T</text></svg>;",
    ],
    ["element", svg(`${title}<style>{'x'}</style>`)],
    ["element", svg(`${title}<use />`)],
    ["element", svg(`${title}<foreignObject />`)],
    ["attribute", svg(`${title}<rect onClick={f} />`)],
    [
      "unknown-component",
      `export default () => { const Box = () => <rect />; return ${svg(`${title}<Box />`).slice(21, -1)}; };`,
    ],
    [
      "visualize",
      "export default () => <claude.Visualize data-claude-component='x'>{() => null}</claude.Visualize>;",
    ],
    ["text-id", svg(`${title}<text x='1' fill='var(--cds-text-primary)'>Untagged</text>`)],
    ["text-id", svg(`${title}<text data-claude-text-id={id} fill='none'>A</text>`)],
    ["text-id", svg(`${title}<text data-claude-text-id='title' fill='none'>Again</text>`)],
    ["text-id", svg(`${title}<text data-claude-text-id='bad id' fill='none'>A</text>`)],
    [
      "text-id",
      svg(
        `${title}{nodes.map(n => <text data-claude-text-id='x' fill='none'>A</text>)}`,
        "const nodes = [];\n",
      ),
    ],
    ["text-literal", svg(`${title}<text data-claude-text-id='a' fill='none'>{label}</text>`)],
    [
      "text-literal",
      svg(
        `${title}<text data-claude-text-id='a' fill='none'><tspan data-claude-text-id='b'>B</tspan></text>`,
      ),
    ],
    ["segment-literal", svg(`${title}<g data-claude-anchor={name} />`)],
    ["colour", svg(`${title}<rect fill='#ff0000' />`)],
    ["colour", svg(`${title}<rect stroke='red' />`)],
    ["colour", svg(`${title}<rect fill='var(--brand)' />`)],
    ["eval-family", svg(`${title}<rect x={xs[i]} />`)],
    ["window-name", `export default () => { const top = 4; return ${svg(title).slice(21, -1)}; };`],
    ["window-name", svg(`${title}<rect x={parent.x} />`)],
    ["deterministic", svg(`${title}<rect x={Math.random()} />`)],
    ["deterministic", svg(`${title}<rect x={new Date().getDate()} />`)],
  ];

  it.each(refused)("refuses with %s", (rule, source) => {
    const rules = analyzeWidget(source).diagnostics.map((entry) => entry.rule);
    expect(rules).toContain(rule);
  });

  it("reports line and column", () => {
    const [diagnostic] = analyzeWidget(`const a = 1;\n${svg(`${title}<use />`)}`).diagnostics;
    expect(diagnostic).toMatchObject({ rule: "element", line: 2 });
    expect(diagnostic!.column).toBeGreaterThan(1);
  });
});
