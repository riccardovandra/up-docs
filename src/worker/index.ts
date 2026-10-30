import { handleApi, type ApiDeps } from "./api.ts";
import { withAssetCaching } from "./assets.ts";
import { parseOwnerEmails } from "./auth.ts";
import { parseEmbedOrigins } from "../shared/embed.ts";
import type { CommentOpResult } from "./comments.ts";
import { docRoom, SOCKET_USER_HEADER } from "./docRoom.ts";
import { reviveError, type TabWriteResult } from "./docs.ts";
import type { Env } from "./env.ts";
import { withEmbedPolicy } from "./embed.ts";
import { r2ImageStore } from "./images.ts";
import { handleMcp } from "./mcp.ts";
import { sendDocInvite, sendLoginCode } from "./email.ts";

export { DocRoom } from "./docRoom.ts";

async function revive<A>(call: PromiseLike<A>): Promise<A> {
  try {
    return await call;
  } catch (cause) {
    throw reviveError(cause);
  }
}

function apiDeps(env: Env, ctx: ExecutionContext): ApiDeps {
  return {
    db: env.DB,
    publicOrigin: env.PUBLIC_ORIGIN,
    owners: parseOwnerEmails(env.OWNER_EMAILS),
    rooms: {
      createTab: (docId, input) => revive(docRoom(env, docId).createTab({ docId, ...input })),
      writeTab: (docId, input) => revive<TabWriteResult>(docRoom(env, docId).writeTab(input)),
      moveTab: (docId, input) => revive(docRoom(env, docId).moveTab(input)),
      deleteTab: (docId, input) => revive(docRoom(env, docId).deleteTab(input)),
      setDocStatus: (docId, input) => revive(docRoom(env, docId).setDocStatus({ docId, ...input })),
      renameDoc: (docId, input) => revive(docRoom(env, docId).renameDoc({ docId, ...input })),
      deleteDoc: (docId, input) => revive(docRoom(env, docId).deleteDoc({ docId, ...input })),
      setDocProject: (docId, input) =>
        revive(docRoom(env, docId).setDocProject({ docId, ...input })),
      commentOp: (docId, input) => revive<CommentOpResult>(docRoom(env, docId).commentOp(input)),
      threadOp: (docId, input) => revive(docRoom(env, docId).threadOp({ docId, ...input })),
      openSocket: (docId, request, userId) => {
        const headers = new Headers(request.headers);
        headers.set(SOCKET_USER_HEADER, userId);
        return docRoom(env, docId).fetch(new Request(request, { headers }));
      },
      closeSockets: (docId, userId) => docRoom(env, docId).closeSockets(userId),
    },
    images: r2ImageStore(env.IMAGES),
    sendLoginCode: (email, code) => sendLoginCode(env, email, code),
    sendDocInvite: (invite) => sendDocInvite(env, invite),
    waitUntil: (promise) => ctx.waitUntil(promise),
    now: () => Date.now(),
  };
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return handleApi(request, apiDeps(env, ctx));
    }
    if (pathname === "/mcp" || pathname.startsWith("/mcp/")) {
      return handleMcp(request, apiDeps(env, ctx));
    }
    return withAssetCaching(
      await withEmbedPolicy(
        await env.ASSETS.fetch(request),
        parseEmbedOrigins(env.FRAME_ANCESTORS),
        env.PUBLIC_ORIGIN,
      ),
      pathname,
    );
  },
} satisfies ExportedHandler<Env>;
