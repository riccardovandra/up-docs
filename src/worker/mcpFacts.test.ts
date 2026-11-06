import { describe, expect, it } from "vitest";

import * as Docs from "./docs.ts";
import { DOC_TYPES } from "./docTypes.ts";
import { makeMcpHarness } from "./testing/mcpHarness.ts";
import { MAX_FACTS_PER_PROJECT } from "./projectFacts.ts";

describe("doc types", () => {
  it("fills the first tab with the type's skeleton and returns a checklist", async () => {
    const mcp = await makeMcpHarness();
    const project = await mcp.tool("create_project", { name: "Acme" });
    for (const type of DOC_TYPES) {
      const created = await mcp.tool("create_doc", {
        projectId: project.body.projectId,
        title: `A ${type}`,
        type,
      });
      expect(created.isError).toBe(false);
      const markdown = await Docs.getTabMarkdown(mcp.api.db, created.body.tab.tabId);
      expect(markdown.startsWith(`# A ${type}\n\n## `)).toBe(true);
      expect(created.body.checklist.length).toBeGreaterThan(2);
    }
  });

  it("puts the plan's purpose and end state before its components", async () => {
    const mcp = await makeMcpHarness();
    const created = await mcp.tool("create_doc", { title: "Launch", type: "plan" });
    const markdown = await Docs.getTabMarkdown(mcp.api.db, created.body.tab.tabId);
    const order = ["## What this is for", "## End state", "## Components", "## Order of work"];
    const positions = order.map((heading) => markdown.indexOf(heading));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("keeps the caller's markdown over the skeleton, and refuses an unknown type", async () => {
    const mcp = await makeMcpHarness();
    const own = await mcp.tool("create_doc", { title: "Mine", type: "spec", markdown: "# Mine\n" });
    expect(await Docs.getTabMarkdown(mcp.api.db, own.body.tab.tabId)).toBe("# Mine\n");
    expect(own.body.checklist).toBeDefined();
    const plain = await mcp.tool("create_doc", { title: "Plain" });
    expect(plain.body.checklist).toBeUndefined();
    const bad = await mcp.tool("create_doc", { title: "Deck", type: "slides" });
    expect(bad.body.error).toBe("invalid_argument");
  });
});

describe("project facts", () => {
  it("adds facts, returns them with create_doc and read_doc, and removes them", async () => {
    const mcp = await makeMcpHarness();
    const { doc } = await mcp.seedDoc("# Plan\n");
    const docProject = (await mcp.tool("read_doc", { docId: doc.docId })).body.doc.projectId;
    const added = await mcp.tool("add_project_fact", {
      projectId: docProject,
      fact: "  We use NocoDB, never Airtable.  ",
    });
    expect(added.isError).toBe(false);
    expect(added.body.fact.text).toBe("We use NocoDB, never Airtable.");
    const projectId = added.body.fact.projectId as string;

    const read = await mcp.tool("read_doc", { docId: doc.docId });
    expect(read.body.projectFacts).toEqual([
      { factId: added.body.fact.factId, text: "We use NocoDB, never Airtable." },
    ]);
    const oneTab = await mcp.tool("read_doc", {
      docId: doc.docId,
      tabId: read.body.tabs[0].tabId,
    });
    expect(oneTab.body.projectFacts).toHaveLength(1);
    const next = await mcp.tool("create_doc", { projectId, title: "Next" });
    expect(next.body.projectFacts).toHaveLength(1);
    const listed = await mcp.tool("project_facts", { projectId });
    expect(listed.body.facts[0]).toMatchObject({ text: "We use NocoDB, never Airtable." });

    const removed = await mcp.tool("remove_project_fact", { factId: added.body.fact.factId });
    expect(removed.body.removed).toBe(true);
    expect((await mcp.tool("project_facts", { projectId })).body.facts).toEqual([]);
    expect((await mcp.tool("create_doc", { title: "No project" })).body.projectFacts).toEqual([]);
  });

  it("finds the project by key and refuses blank or ambiguous input", async () => {
    const mcp = await makeMcpHarness();
    await mcp.tool("create_doc", { projectKey: "github.com/acme/app", title: "Spec" });
    const added = await mcp.tool("add_project_fact", {
      projectKey: "github.com/acme/app",
      fact: "The product is called Uplifted Content, not Eden.",
    });
    expect(added.isError).toBe(false);
    const blank = await mcp.tool("add_project_fact", {
      projectKey: "github.com/acme/app",
      fact: "   ",
    });
    expect(blank.body.error).toBe("invalid_argument");
    const neither = await mcp.tool("project_facts", {});
    expect(neither.body.error).toBe("invalid_argument");
    const unknown = await mcp.tool("project_facts", { projectKey: "github.com/acme/none" });
    expect(unknown.body.error).toBe("not_found");
  });

  it("caps facts per project", async () => {
    const mcp = await makeMcpHarness();
    const project = await mcp.tool("create_project", { name: "Acme" });
    const { projectId } = project.body;
    for (let index = 0; index < MAX_FACTS_PER_PROJECT; index += 1) {
      await mcp.tool("add_project_fact", { projectId, fact: `Fact ${index}` });
    }
    const over = await mcp.tool("add_project_fact", { projectId, fact: "One too many" });
    expect(over.body.error).toBe("too_many_facts");
  });

  it("saves a resolved thread's lesson to the project", async () => {
    const mcp = await makeMcpHarness();
    const { doc, tab } = await mcp.seedDoc("# Plan\n\nRead the Airtable formula.\n");
    const comment = await mcp.tool("create_comment", {
      tabId: tab.tabId,
      quote: "Airtable formula",
      body: "We are not using Airtable anymore.",
    });
    const threadId = comment.body.comment.commentId;
    const resolved = await mcp.tool("resolve_comment", {
      commentId: threadId,
      lesson: "Airtable is retired: never use its formulas.",
    });
    expect(resolved.body).toMatchObject({
      resolved: true,
      fact: { text: "Airtable is retired: never use its formulas." },
    });
    const read = await mcp.tool("read_doc", { docId: doc.docId });
    expect(read.body.projectFacts.map((fact: { text: string }) => fact.text)).toEqual([
      "Airtable is retired: never use its formulas.",
    ]);
    const listed = await mcp.tool("project_facts", { projectId: read.body.doc.projectId });
    expect(listed.body.facts[0].sourceCommentId).toBe(threadId);
  });

  it("refuses a lesson on a doc in no project without resolving the thread", async () => {
    const mcp = await makeMcpHarness();
    const created = await mcp.tool("create_doc", { title: "Loose", markdown: "Some text here.\n" });
    const comment = await mcp.tool("create_comment", {
      tabId: created.body.tab.tabId,
      quote: "text here",
      body: "Fix",
    });
    const refused = await mcp.tool("resolve_comment", {
      commentId: comment.body.comment.commentId,
      lesson: "Something",
    });
    expect(refused.body.error).toBe("no_project");
    const listed = await mcp.tool("list_comments", { docId: created.body.doc.docId });
    expect(JSON.stringify(listed.body)).toContain('"resolved":false');
  });

  it("lets a doc's viewer read facts but not change them", async () => {
    const mcp = await makeMcpHarness();
    const { doc } = await mcp.seedDoc("# Plan\n");
    const projectId = (await mcp.tool("read_doc", { docId: doc.docId })).body.doc.projectId;
    const fact = await mcp.tool("add_project_fact", { projectId, fact: "Rule one." });
    await mcp.tool("share_doc", { docId: doc.docId, email: "viewer@example.com", role: "viewer" });
    const asViewer = await mcp.asUser("viewer@example.com");
    expect((await asViewer("project_facts", { projectId })).body.facts).toHaveLength(1);
    const add = await asViewer("add_project_fact", { projectId, fact: "Rule two." });
    expect(add.body.error).toBe("forbidden");
    const remove = await asViewer("remove_project_fact", { factId: fact.body.fact.factId });
    expect(remove.body.error).toBe("forbidden");

    await mcp.tool("share_doc", { docId: doc.docId, email: "editor@example.com", role: "editor" });
    const asEditor = await mcp.asUser("editor@example.com");
    expect((await asEditor("add_project_fact", { projectId, fact: "Rule two." })).isError).toBe(
      false,
    );
  });
});
