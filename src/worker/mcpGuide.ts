// The full format specs behind the `format_guide` tool. They used to sit in
// the server instructions, but clients cut long instructions short (Claude
// Code keeps about 4,000 characters), so the instructions now carry a short
// summary and point here.

const DRAWIO_BOX = "rounded=1;whiteSpace=wrap;html=1;";
const DRAWIO_ARROW = "edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=block;";

/** The guide's Draw.io example: a flow with a decision and a loop back. */
export const DRAWIO_EXAMPLE = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="call" value="Discovery call" style="${DRAWIO_BOX}fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1"><mxGeometry x="40" y="60" width="140" height="60" as="geometry"/></mxCell>
<mxCell id="proposal" value="Proposal" style="${DRAWIO_BOX}fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1"><mxGeometry x="240" y="60" width="140" height="60" as="geometry"/></mxCell>
<mxCell id="signed" value="Signed?" style="rhombus;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;" vertex="1" parent="1"><mxGeometry x="440" y="50" width="100" height="80" as="geometry"/></mxCell>
<mxCell id="kickoff" value="Kickoff" style="${DRAWIO_BOX}fillColor=#d5e8d4;strokeColor=#82b366;" vertex="1" parent="1"><mxGeometry x="600" y="60" width="140" height="60" as="geometry"/></mxCell>
<mxCell id="e1" style="${DRAWIO_ARROW}" edge="1" parent="1" source="call" target="proposal"><mxGeometry relative="1" as="geometry"/></mxCell>
<mxCell id="e2" style="${DRAWIO_ARROW}" edge="1" parent="1" source="proposal" target="signed"><mxGeometry relative="1" as="geometry"/></mxCell>
<mxCell id="e3" value="yes" style="${DRAWIO_ARROW}" edge="1" parent="1" source="signed" target="kickoff"><mxGeometry relative="1" as="geometry"/></mxCell>
<mxCell id="e4" value="no: revise" style="${DRAWIO_ARROW}" edge="1" parent="1" source="signed" target="proposal"><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="490" y="180"/><mxPoint x="310" y="180"/></Array></mxGeometry></mxCell>
</root></mxGraphModel>`;

export const FORMAT_GUIDES = {
  diagram: `Diagrams use Claude's widget format: a fenced block \`\`\`t3-widget id=<slug>\` whose body is ONE JS/JSX module, \`export default () => <svg viewBox='0 0 760 H' role='img' aria-label='<title words>'>…</svg>;\` (a block body with consts and lowercase helpers is fine). The id names the diagram in its tab and never changes. Writes with an invalid diagram are refused with rule names and line:col.
- Every <text> or <tspan> whose words you type carries its own LITERAL data-claude-text-id='<slug>' (letters, digits, _ -, max 64, unique). Words are literal JSX text, written out one by one, never computed or inside .map()/helpers. Two lines = two <tspan data-claude-text-id>; no id on a <text> that holds tspans. The first <text> is the title: say the finding, not the topic.
- Wrap each box with its labels in <g data-claude-anchor='<slug>'> (a literal, or a template literal in a loop).
- Colours are tokens only, never hex or names: var(--cds-text-primary), --cds-text-secondary, --cds-chart-axis (borders, connectors, arrowheads), --cds-chart-grid, --cds-chart-reference-tint, --cds-chart-categorical-1..8, --cds-chart-status-good|warning|critical. Every <text> sets fill. Box fill 'none'; one accent = categorical-1 at fillOpacity 0.12.
- Refused: <style>, <use>, <foreignObject>, event handlers, href; the names top, parent, self, window; computed indexes xs[i] (use xs.at(i) or pos.commit); Math.random, Date.now, timers; claude.Visualize data charts.
- Frame: viewBox width 760, height = drawing + ~24. fontSize ≥ 10.5 (13 to read, 15 for the title, names fontWeight 600), rx 8, strokeWidth 1 to 1.25. SVG does not wrap: break lines yourself (a 13px line is ~7 units a character).
- To change words, edit_diagram_label {tabId, diagramId, textId, value}; read_diagram returns the code and its text ids. Redraw with edit_tab only for layout changes, keeping every text id and the words as read (people edit them).
Example (five boxes, one decision, a loop back):
\`\`\`t3-widget id=release-flow
export default () => { const W = 156, H = 48, rowA = 110, rowB = 230, c1 = 102, c2 = 290, cd = 456, c3 = 634; const edge = 'var(--cds-chart-axis)', accent = 'var(--cds-chart-categorical-1)', ink = 'var(--cds-text-primary)', quiet = 'var(--cds-text-secondary)'; const box = (cx, cy, main) => <rect x={cx - W / 2} y={cy - H / 2} width={W} height={H} rx='8' fill={main ? accent : 'none'} fillOpacity={main ? 0.12 : 1} stroke={main ? accent : edge} strokeWidth={main ? 2 : 1.25}/>; return <svg viewBox='0 0 760 280' role='img' aria-label='Only a green build reaches production' fontSize='13'><defs><marker id='flow-arrow' viewBox='0 0 10 10' refX='9' refY='5' markerWidth='6' markerHeight='6' orient='auto-start-reverse'><path d='M0 0L10 5L0 10z' fill={edge}/></marker></defs><text data-claude-text-id='title' x='24' y='34' fontSize='15' fontWeight='600' fill={ink}>Only a green build reaches production</text><g data-claude-anchor='connectors' fill='none' stroke={edge} strokeWidth='1.25'><path d={\`M\${c1 + W / 2} \${rowA}H\${c2 - W / 2}\`} markerEnd='url(#flow-arrow)'/><path d={\`M\${c2 + W / 2} \${rowA}H\${cd - 64}\`} markerEnd='url(#flow-arrow)'/><path d={\`M\${cd + 64} \${rowA}H\${c3 - W / 2}\`} markerEnd='url(#flow-arrow)'/><path d={\`M\${cd} \${rowA + 40}V\${rowB - H / 2}\`} markerEnd='url(#flow-arrow)'/><path d={\`M\${c3} \${rowA + H / 2}V\${rowB - H / 2}\`} markerEnd='url(#flow-arrow)'/><path d={\`M\${cd - W / 2} \${rowB}H\${c1}V\${rowA + H / 2}\`} markerEnd='url(#flow-arrow)'/></g><g data-claude-anchor='step-commit'>{box(c1, rowA, false)}<text data-claude-text-id='commit' x={c1} y={rowA + 4} textAnchor='middle' fill={ink}>Commit lands</text></g><g data-claude-anchor='step-build'>{box(c2, rowA, false)}<text data-claude-text-id='build' x={c2} y={rowA + 4} textAnchor='middle' fill={ink}>Build and test</text></g><g data-claude-anchor='decision-tests'><polygon points={\`\${cd - 64},\${rowA} \${cd},\${rowA - 40} \${cd + 64},\${rowA} \${cd},\${rowA + 40}\`} fill='none' stroke={edge} strokeWidth='1.25'/><text data-claude-text-id='tests-pass' x={cd} y={rowA + 4} textAnchor='middle' fill={ink}>Tests pass?</text></g><g data-claude-anchor='step-staging'>{box(c3, rowA, false)}<text data-claude-text-id='staging' x={c3} y={rowA + 4} textAnchor='middle' fill={ink}>Deploy to staging</text></g><g data-claude-anchor='step-ship'>{box(c3, rowB, true)}<text data-claude-text-id='ship' x={c3} y={rowB + 4} textAnchor='middle' fontWeight='600' fill={ink}>Ship to production</text></g><g data-claude-anchor='step-notify'>{box(cd, rowB, false)}<text data-claude-text-id='notify' x={cd} y={rowB + 4} textAnchor='middle' fill={ink}>Notify the author</text></g><text data-claude-text-id='yes' x={cd + 82} y={rowA - 8} textAnchor='middle' fontSize='11.5' fill={quiet}>yes</text><text data-claude-text-id='no' x={cd + 10} y={rowA + 72} fontSize='11.5' fill={quiet}>no</text><text data-claude-text-id='smoke' x={c3 - 10} y={rowA + 72} textAnchor='end' fontSize='11.5' fill={quiet}>smoke checks pass</text><text data-claude-text-id='fix-and-push' x={(c1 + cd - W / 2) / 2} y={rowB - 8} textAnchor='middle' fontSize='11.5' fill={quiet}>fix and push</text></svg>; };
\`\`\``,
  table: `Rich tables (status chips, links, per-cell comments): a \`\`\`t3-table block whose body is JSON. Ids are yours to pick (letters, digits, _ and -) and must stay stable. Column types: text, select (cells hold one of its options' values; colors gray, blue, green, yellow, orange, red, purple, pink), link (cells are {"text","url"}), number, date ("YYYY-MM-DD"). Example:
\`\`\`t3-table
{"id":"requests","columns":[{"id":"req","name":"Request","type":"text"},{"id":"status","name":"Status","type":"select","options":[{"value":"Not started","color":"gray"},{"value":"Done","color":"green"}]},{"id":"ticket","name":"Ticket","type":"link"}],"rows":[{"id":"r1","cells":{"req":"Fix Zebra MCP","status":"Not started","ticket":{"text":"TASK-5575","url":"https://example.atlassian.net/browse/TASK-5575"}}}]}
\`\`\`
Change one cell with update_table_cell and add rows with add_table_row rather than rewriting the block. Plain markdown tables still work for static data. A \`<!-- col-widths: 120 240 0 -->\` line directly above a plain table holds the column widths the user dragged; keep it with the table when you edit it.`,
  drawio: `Draw.io diagrams are library items of their own: each is stored once, in a project or in none, opens in the real Draw.io editor, and shows in every doc that links it, so one save updates them all.
When to use which: draw a Draw.io diagram when the user asks for Draw.io, wants to rework the drawing by hand, or wants one diagram in several docs. Use a code-drawn \`\`\`t3-widget diagram (topic "diagram") for a figure that belongs to one doc and that you keep in step with its text. Never turn one kind into the other unasked.
Tools:
- list_drawio: the diagrams the user manages. read_drawio {diagramId}: title, project, the docs that use it, shapes, connections and the picture. diagramId is the id or the diagram's link.
- Connections read "A -> B", or "A -[label]-> B" with a label. "<->" has an arrowhead at both ends, "<-" only at the start, "--" none. "(loose end)" is an end attached to no shape.
- create_drawio {projectKey or projectId, title, xml} returns the id, the link and the block to paste into a doc.
- To change a diagram: read_drawio {diagramId, includeXml: true}, edit that XML keeping the ids of the cells you keep, and send the whole XML with update_drawio {diagramId, xml, baseVersion: the version you read}; a new title goes the same way. A stale baseVersion is refused because someone saved in between: read again and redo the change. Only the diagram's creator and the workspace admin get the XML or may change it.
Linking: a doc shows a diagram through this block, whose first line is the diagram id and whose optional second line is a caption, nothing else. read_doc describes every linked diagram in drawioDiagrams, so you rarely need read_drawio for them. The block shows the diagram to the others on a doc only when the diagram's creator can edit that doc; to anyone else it reads as missing.
\`\`\`t3-drawio
<diagram id>
Optional caption
\`\`\`
The picture: you write only the XML. Draw.io draws the picture in a browser, the first time a person who manages the diagram opens it or a doc that links it. Until then read_drawio has no picture and docs show "Picture not ready yet". Say so when you hand over the link.
Writing the XML (one uncompressed <mxGraphModel>):
- Skeleton: <mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/> ...your cells... </root></mxGraphModel>. Cells 0 and 1 are required. Every shape and connection has parent="1" and an id of its own.
- Shape: <mxCell id="a" value="Label" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="140" height="60" as="geometry"/></mxCell>. x and y are the top-left corner and y grows downward. 140 by 60 fits two short lines; leave 60 or more between shapes for the arrows.
- Connection: <mxCell id="e1" value="optional label" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=block;" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry"/></mxCell>. source and target are shape ids, so the arrow follows when a person moves a shape. Never place a connection by coordinates alone. To route one around a shape, add <Array as="points"><mxPoint x=".." y=".."/></Array> inside its mxGeometry.
- Safe styles: rounded=1 (step), rhombus (decision), ellipse (start or end), shape=cylinder3 (data store), text;html=1 (words without a box), swimlane (a titled container: give the shapes inside it parent="<its id>" and positions relative to it). Colours as pairs: fillColor=#dae8fc;strokeColor=#6c8ebf (blue), #d5e8d4 and #82b366 (green), #fff2cc and #d6b656 (yellow), #f8cecc and #b85450 (red), #e1d5e7 and #9673a6 (purple). dashed=1, fontStyle=1 (bold), endArrow=none (a plain line). Keep whiteSpace=wrap;html=1 on every shape.
- It is XML: inside value write &amp; &lt; &gt; &quot;, and a line break as &lt;br&gt;. &nbsp; is not XML. Do not compress or base64-encode anything.
- Writes are checked. XML that is not well-formed is refused with the line. The result lists the shapes and connections as read, and warns when a connection or a parent names an id that no cell has.
Example (a flow with a decision and a loop back):
${DRAWIO_EXAMPLE}`,
  video: `Videos play inside the doc from a \`\`\`t3-video block. Its first line is the source and its optional second line is the title, nothing else. The source is a YouTube link (watch, youtu.be, shorts, embed), a Loom link (share, embed), or a /api/videos/<docId>/<file> URL already uploaded in the editor; agents cannot upload video files. Bare links stay plain links. Example:
\`\`\`t3-video
https://www.youtube.com/watch?v=dQw4w9WgXcQ
Release walkthrough
\`\`\``,
  embed: `Posts embed from a \`\`\`t3-embed block: the first line is one https link and the optional second line is a caption, nothing else. LinkedIn and X posts show the provider's own embed, and the doc also keeps a saved copy (author, text, image) taken the first time it is opened; X articles show that copy; any other link shows as a link card. \`\`\`t3-embed compact shows only the author and the first two lines, no image, until the reader expands it: use it when a doc holds many posts. Use an embed when the post itself should be visible in the doc. Example:
\`\`\`t3-embed
https://www.linkedin.com/posts/name_slug-activity-7209442266791186432-uyzh
Hook: a number in the first line
\`\`\``,
  image: `Images are markdown: ![alt](src), alone on a line or inside text. Every image the doc shows is its own copy under /api/images/<docId>/<file>; readers' browsers never load another site.
- A public https link: write ![alt](https://...) with create_doc, create_tab, edit_tab or write_tab. The Worker downloads it once, saves the copy and writes the copy's path instead; the result's "images" field lists what was copied and what failed. A failed link stays as written and shows as its alt text. import_image {docId, url, alt} does the same for one link and returns the markdown. Up to 20 links per write.
- A file on your machine (a screenshot, an exported chart, an image from a downloaded document): prepare_image_upload {docId}, then run its curl command with the file and its Content-Type. The reply is {"url","markdown"}; insert the markdown with edit_tab. Use this for links that need a sign-in, such as Google Docs images: download the file first.
- PNG, JPEG, GIF or WebP, up to 10 MB. A width after a pipe sets the display size: ![Chart|480](/api/images/...).`,
  comments: `Comments: when asked to review or address comments, list_comments, make the requested edits in the doc, reply_comment in each thread saying what changed (or answering the question), and resolve_comment once a thread is fully handled. To raise a point on a passage, create_comment with a short exact quote from the tab; on a table cell, pass anchor {"kind":"cell","blockId":<table id>,"rowId","colId"} instead, and on a diagram label {"kind":"label","blockId":<diagram id>,"textId"}.`,
  sharing: `Sharing: docs are private to the people on them. share_doc gives someone access by email (owner, editor, commenter or viewer); list_members and unshare_doc manage it. You act with the role of the person whose token you use.`,
  claude_push: `Claude Docs push: to put a tab into a Claude Doc (claude.ai) as a tab, call prepare_claude_doc_push {tabId, claudeDocId}; it writes nothing and returns the converted markdown, one widget per diagram (code copied byte for byte) and Claude Docs members. Mode "new": send its batch to the Claude Docs batch tool in the given order. Mode "update" (pushed before): send widgetCreates and replace the prose body with content. Show the warnings (rich tables, videos, embeds, mermaid and uploaded images do not carry over as-is). Then call record_claude_doc_push with the Claude Docs ids, {slug: {nodeId, hash}} and the prose rev, so the next push updates the same tab.`,
} as const;

export type FormatTopic = keyof typeof FORMAT_GUIDES;

export const FORMAT_TOPICS = Object.keys(
  FORMAT_GUIDES,
) as ReadonlyArray<FormatTopic>;
