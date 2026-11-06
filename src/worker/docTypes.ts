// Doc types for create_doc: a skeleton in the shape the user keeps asking for,
// and a short checklist the agent gets back with the new doc. The shapes come
// from an audit of the user's feedback on agent-written docs: purpose and
// reader first, the end state before the parts, a goal and done-when for each
// part, plain words, and a diagram for anything that moves.

export const DOC_TYPES = ["plan", "spec", "explainer", "report", "client"] as const;

export type DocType = (typeof DOC_TYPES)[number];

export const isDocType = (value: unknown): value is DocType =>
  typeof value === "string" && (DOC_TYPES as ReadonlyArray<string>).includes(value);

interface DocTypeShape {
  /** Section heading and its one-line placeholder. */
  readonly sections: ReadonlyArray<readonly [string, string]>;
  readonly checklist: ReadonlyArray<string>;
}

const SHARED_CHECKLIST = [
  "Define every term, acronym and ID where it first appears.",
  "Draft each section in a few lines; grow it when the user asks.",
  "Follow the project facts returned with this doc; ask instead of guessing others.",
];

const SHAPES: Record<DocType, DocTypeShape> = {
  plan: {
    sections: [
      ["What this is for", "Who reads this and the decision or outcome it drives."],
      ["End state", "What exists when this is done, drawn as a diagram."],
      [
        "Components",
        "One subsection per component: its goal, when it is done, and how it fits with the others.",
      ],
      ["Order of work", "Easiest or first-needed first, and why."],
      ["Open decisions", "What the reader decides, each with a recommendation."],
    ],
    checklist: [
      "Lead with purpose and end state; detail goes in the components.",
      "Each component states its goal and when it is done.",
      "Draw the end state; draw any flow or data model a component changes.",
    ],
  },
  spec: {
    sections: [
      ["What this is for", "Who reads this and what it lets them build or decide."],
      ["How it works today", "The current flow or data model, drawn as a diagram."],
      ["What changes", "The target, drawn as before and after."],
      ["Components", "One subsection per component: its goal and when it is done."],
      ["Risks and open questions", "What could go wrong and what is still undecided."],
    ],
    checklist: [
      "Explain the foundation (data model, flow) before the details that depend on it.",
      "Describe behaviour in plain words or pseudo-code, not raw field names.",
    ],
  },
  explainer: {
    sections: [
      ["The short answer", "Two or three sentences a newcomer understands."],
      ["How it works", "The mechanism, drawn as a diagram."],
      ["Why it works this way", "The reasons and the alternatives that were rejected."],
      ["What this means for you", "What the reader does or decides with this."],
    ],
    checklist: [
      "Write for someone with no context: build up from the base.",
      "One diagram per idea, beside the text it explains.",
    ],
  },
  report: {
    sections: [
      ["Bottom line", "The findings that matter and the recommendation."],
      ["What was looked at", "Sources, scope and method, briefly."],
      ["Findings", "Each finding with its evidence, most important first."],
      ["Recommendation and next steps", "What to do, in order, and who does it."],
    ],
    checklist: [
      "Simple to read, full depth: keep the evidence, cut the filler.",
      "Chart or draw comparisons and trends instead of describing them.",
    ],
  },
  client: {
    sections: [
      ["What this covers", "Why we are talking and what you get from this."],
      ["Where you are today", "Your current situation in your own terms."],
      ["What we propose", "The approach, drawn as a diagram, and what it changes for you."],
      ["What happens next", "The next steps and what we need from you."],
    ],
    checklist: [
      "Write to the client in the second person, as a teaching document.",
      "No internal terms, tool names, ticket or PR numbers.",
    ],
  },
};

/** The first tab's markdown for a new doc of this type. */
export function docTypeSkeleton(type: DocType, title: string): string {
  const sections = SHAPES[type].sections
    .map(([heading, placeholder]) => `## ${heading}\n\n${placeholder}`)
    .join("\n\n");
  return `# ${title}\n\n${sections}\n`;
}

/** What the agent should keep in mind while filling a doc of this type. */
export function docTypeChecklist(type: DocType): ReadonlyArray<string> {
  return [...SHAPES[type].checklist, ...SHARED_CHECKLIST];
}
