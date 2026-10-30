import type { RoomMessage } from "../../shared/protocol.ts";
import { handleApi, type ApiDeps } from "../api.ts";
import { parseOwnerEmails } from "../auth.ts";
import * as Comments from "../comments.ts";
import * as DocThreads from "../docThreads.ts";
import * as Docs from "../docs.ts";
import type { DocInvite } from "../email.ts";
import { makeTestD1 } from "./sqliteD1.ts";

export const ORIGIN = "https://docs.test";
export const OWNER = "owner@example.com";

/** Runs the real API against an in-memory D1, with DocRooms that apply writes inline and record broadcasts. */
export function makeApiHarness() {
  const db = makeTestD1();
  const clock = { now: 1_000_000 };
  const sentCodes: Array<{ email: string; code: string }> = [];
  const broadcasts: Array<RoomMessage> = [];
  const invites: Array<DocInvite> = [];
  const sockets: Array<{ docId: string; userId: string; open: boolean }> = [];
  const images = new Map<string, { body: ArrayBuffer; contentType: string }>();
  const deps: ApiDeps = {
    db,
    publicOrigin: ORIGIN,
    owners: parseOwnerEmails(`${OWNER}, second@example.com`),
    rooms: {
      createTab: async (docId, { origin, ...input }) => {
        const tab = await Docs.createTab(db, { docId, ...input, now: clock.now });
        broadcasts.push({ type: "tab.created", tab, origin });
        return tab;
      },
      writeTab: async (_docId, { origin, ...input }) => {
        const result = await Docs.writeTab(db, { ...input, now: clock.now });
        if (result.ok) broadcasts.push({ type: "tab.updated", tab: result.tab, origin });
        return result;
      },
      moveTab: async (_docId, { origin, ...input }) => {
        const placements = await Docs.moveTab(db, { ...input, now: clock.now });
        if (placements.length > 0) broadcasts.push({ type: "tab.moved", placements, origin });
        return placements;
      },
      deleteTab: async (_docId, { origin, tabId }) => {
        const { deletedTabIds, placements } = await Docs.deleteTab(db, { tabId, now: clock.now });
        broadcasts.push({ type: "tab.deleted", tabIds: deletedTabIds, placements, origin });
        return deletedTabIds;
      },
      setDocStatus: async (docId, { origin, status }) => {
        const doc = await Docs.setDocStatus(db, { docId, status, now: clock.now });
        broadcasts.push({ type: "doc.updated", doc, origin });
        return doc;
      },
      renameDoc: async (docId, { origin, title }) => {
        const doc = await Docs.renameDoc(db, { docId, title, now: clock.now });
        broadcasts.push({ type: "doc.updated", doc, origin });
        return doc;
      },
      deleteDoc: async (docId, { origin }) => {
        await Docs.deleteDoc(db, docId);
        broadcasts.push({ type: "doc.deleted", docId, origin });
        for (const socket of sockets) if (socket.docId === docId) socket.open = false;
      },
      setDocProject: async (docId, { origin, projectId }) => {
        const doc = await Docs.setDocProject(db, { docId, projectId });
        broadcasts.push({ type: "doc.updated", doc, origin });
        return doc;
      },
      commentOp: async (_docId, { origin, op }) => {
        const result = await Comments.applyCommentOp(db, op, clock.now);
        broadcasts.push(Comments.commentMessage(result, origin));
        return result;
      },
      threadOp: async (docId, { origin, op }) => {
        const threads = await DocThreads.applyDocThreadOp(db, docId, op, clock.now);
        broadcasts.push({ type: "doc.threads", threads, origin });
        return threads;
      },
      openSocket: async (docId, _request, userId) => {
        sockets.push({ docId, userId, open: true });
        return new Response(null, { status: 204 });
      },
      closeSockets: async (docId, userId) => {
        for (const socket of sockets) {
          if (socket.docId === docId && socket.userId === userId) socket.open = false;
        }
      },
    },
    images: {
      put: async (key, body, contentType) => {
        images.set(key, { body, contentType });
      },
      get: async (key) => images.get(key) ?? null,
      deletePrefix: async (prefix) => {
        for (const key of [...images.keys()]) if (key.startsWith(prefix)) images.delete(key);
      },
    },
    sendLoginCode: async (email, code) => {
      sentCodes.push({ email, code });
    },
    sendDocInvite: async (invite) => {
      invites.push(invite);
    },
    // Run inline so tests see the invite once the request returns.
    waitUntil: (promise) => void promise,
    now: () => clock.now,
  };

  const call = (
    method: string,
    path: string,
    options: { body?: unknown; headers?: Record<string, string> } = {},
  ) =>
    handleApi(
      new Request(ORIGIN + path, {
        method,
        headers: {
          Origin: ORIGIN,
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...options.headers,
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      }),
      deps,
    );

  const signIn = async (email = OWNER): Promise<string> => {
    await call("POST", "/api/auth/request-code", { body: { email } });
    const sent = sentCodes.findLast((entry) => entry.email === email);
    if (!sent) throw new Error("no code sent");
    const response = await call("POST", "/api/auth/verify", { body: { email, code: sent.code } });
    const cookie = response.headers.get("Set-Cookie");
    if (!cookie) throw new Error("no session cookie");
    return cookie.split(";")[0]!;
  };

  return { db, clock, deps, sentCodes, broadcasts, invites, sockets, images, call, signIn };
}
