// Designs: OpenPencil (.fig) files as library items of their own. The editor
// is the fork's static build, served on its own origin (DESIGNER_ORIGIN) and
// shown in a frame on the design page; the page and the editor talk only by
// postMessage (the host protocol below). Every save is a whole .fig file plus a
// PNG picture of the editor's current page, and becomes the next version.
//
// Owners: S2 (library, storage, host page). S3 (agent tools) and S4 (designs in
// docs) build on the exports here and do not change them without asking.

import type { DocRole } from "./access.ts";

/** The largest .fig file a save may hold. Bigger saves are refused with `design_too_large`. */
export const MAX_DESIGN_FIG_BYTES = 20 * 1024 * 1024;
/** The largest picture kept. A bigger one is dropped and the save keeps the older picture. */
export const MAX_DESIGN_PICTURE_BYTES = 4 * 1024 * 1024;
/** How many versions each design keeps; older ones are deleted on save. */
export const DESIGN_VERSIONS_KEPT = 20;
export const MAX_DESIGN_TITLE_LENGTH = 200;
export const DEFAULT_DESIGN_TITLE = "Untitled design";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
export const isDesignId = (value: string) => ID.test(value);

/** The library's Designs view. */
export const DESIGNS_PATH = "/designs";
/** One design's own page (the editor, or the picture on a touch-only device). */
export const designPath = (designId: string) => `${DESIGNS_PATH}/${designId}`;
export const designUrl = (origin: string, designId: string) => `${origin}${designPath(designId)}`;
/** The picture drawn from one version. The bytes never change, so it caches for good. */
export const designPicturePath = (designId: string, pictureVersion: number) =>
  `/api/designs/${designId}/picture/${pictureVersion}`;
/** The current .fig file. */
export const designFigPath = (designId: string) => `/api/designs/${designId}/fig`;
/**
 * Where a save goes: the .fig bytes followed by the PNG bytes as one
 * `application/octet-stream` body, `figBytes` long for the first part.
 */
export const designSavePath = (
  designId: string,
  input: { readonly baseVersion: number; readonly figBytes: number },
) =>
  `/api/designs/${designId}/versions?baseVersion=${input.baseVersion}&figBytes=${input.figBytes}`;

/**
 * The agent bridge's WebSocket for one open design (S3). Reserved by S2: it is
 * the only app path a request from the editor's origin may reach, and it must
 * authenticate with a one-use ticket, never the session cookie. Until S3
 * serves it, it answers 404.
 */
export const designAgentSocketPath = (designId: string) => `/api/designs/${designId}/agent`;
const AGENT_SOCKET_PATH = /^\/api\/designs\/[A-Za-z0-9_-]{1,64}\/agent$/;
export const isDesignAgentSocketPath = (pathname: string) => AGENT_SOCKET_PATH.test(pathname);

/**
 * Where the editor's build is served on its origin. On the editor's own
 * origin every path is the editor's; on the app's origin (no DESIGNER_ORIGIN)
 * only this prefix is.
 */
export const DESIGNER_BASE_PATH = "/designer/";

/** The editor frame's address: host mode, and the app's origin it may talk to. */
export const designerFrameUrl = (editorOrigin: string, appOrigin: string) =>
  `${editorOrigin}${DESIGNER_BASE_PATH}?host=up-docs&parent=${encodeURIComponent(appOrigin)}`;

/** A design without its file: what lists and headers need. */
export interface DesignSummary {
  readonly id: string;
  /** Null for a design in no project. */
  readonly projectId: string | null;
  readonly title: string;
  /** The latest save; 0 for a new design with no file yet. */
  readonly version: number;
  /** The version the picture was drawn from; null before the first picture. */
  readonly pictureVersion: number | null;
  readonly createdBy: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** `GET /api/designs`: one design with the caller's role on it. */
export interface DesignListItem extends DesignSummary {
  readonly role: DocRole;
}

/** Where the design page frames the editor. */
export interface DesignEditorConfig {
  /** The editor's own origin; null when it is served under /designer/ on the app's origin. */
  readonly origin: string | null;
}

/** `GET /api/designs/:id`: the design as one caller may see it. */
export interface DesignView extends DesignSummary {
  readonly role: DocRole;
  readonly canEdit: boolean;
  /** Size of the current .fig file in bytes; 0 before the first save. */
  readonly figBytes: number;
  readonly editor: DesignEditorConfig;
}

/** `POST /api/designs/:id/versions`: the saved design, and whether its picture was kept. */
export interface DesignSaveResult {
  readonly design: DesignView;
  /** Set when the save's picture was not stored (the older picture stays). */
  readonly pictureSkipped?: "too_large" | "invalid";
}

/** A picture URL for a design, or null before its first picture. */
export const designPictureUrl = (design: Pick<DesignSummary, "id" | "pictureVersion">) =>
  design.pictureVersion === null ? null : designPicturePath(design.id, design.pictureVersion);

// Host protocol, version 1: the fork's src/app/host/up-docs/bridge.ts (its header is the
// source of truth). Every message is a `{ type, ... }` object, posted only to the other
// side's exact origin; each side ignores messages from any other origin or window.
export const DESIGNER_PROTOCOL = 1;

export const DESIGNER_MESSAGE = {
  /** editor -> host: `{ protocol, version }`, ready for `load`. */
  ready: "up-designer:ready",
  /** host -> editor: `{ bytes: ArrayBuffer | null, name?, socketURL? }`. Blank only the first time. */
  load: "up-designer:load",
  /** editor -> host: `{ nodes }`, once the file is open. */
  loaded: "up-designer:loaded",
  /** host -> editor: `{ socketURL }`, a new agent bridge ticket (S3). */
  connect: "up-designer:connect",
  /** editor -> host: `{ seq, fig, png | null, width, height, nodes }`, one at a time. */
  save: "up-designer:save",
  /** host -> editor: `{ seq }` within 10 s, or the editor counts the save as failed. */
  saved: "up-designer:saved",
  /** host -> editor: save now, changed or not. */
  saveNow: "up-designer:save-now",
  /** host -> editor: save only what is unsaved (a page about to close). */
  flush: "up-designer:flush",
  /** editor -> host: `{ saved, unsaved }`, the answer to `flush`. */
  flushed: "up-designer:flushed",
  /** editor -> host: `{ reason, message }`. */
  error: "up-designer:error",
} as const;

export type DesignerErrorReason =
  | "unsupported-browser"
  | "boot-failed"
  | "invalid-message"
  | "load-failed"
  | "save-failed";

export type DesignerEditorMessage =
  | {
      readonly type: typeof DESIGNER_MESSAGE.ready;
      readonly protocol: number | null;
      readonly version: string | null;
    }
  | { readonly type: typeof DESIGNER_MESSAGE.loaded; readonly nodes: number | null }
  | {
      readonly type: typeof DESIGNER_MESSAGE.save;
      readonly seq: number;
      readonly fig: ArrayBuffer;
      readonly png: ArrayBuffer | null;
    }
  | {
      readonly type: typeof DESIGNER_MESSAGE.flushed;
      readonly saved: boolean;
      readonly unsaved: boolean;
    }
  | {
      readonly type: typeof DESIGNER_MESSAGE.error;
      /** One of DesignerErrorReason, or another string from a newer editor. */
      readonly reason: string;
      readonly message: string;
    };

const isBuffer = (value: unknown): value is ArrayBuffer => value instanceof ArrayBuffer;

/** An editor message the host acts on, or null for anything else. */
export function parseDesignerMessage(data: unknown): DesignerEditorMessage | null {
  if (!data || typeof data !== "object") return null;
  const fields = data as Record<string, unknown>;
  switch (fields.type) {
    case DESIGNER_MESSAGE.ready:
      return {
        type: DESIGNER_MESSAGE.ready,
        protocol: typeof fields.protocol === "number" ? fields.protocol : null,
        version: typeof fields.version === "string" ? fields.version.slice(0, 100) : null,
      };
    case DESIGNER_MESSAGE.loaded:
      return {
        type: DESIGNER_MESSAGE.loaded,
        nodes: typeof fields.nodes === "number" ? fields.nodes : null,
      };
    case DESIGNER_MESSAGE.save:
      if (typeof fields.seq !== "number" || !isBuffer(fields.fig)) return null;
      return {
        type: DESIGNER_MESSAGE.save,
        seq: fields.seq,
        fig: fields.fig,
        png: isBuffer(fields.png) && fields.png.byteLength > 0 ? fields.png : null,
      };
    case DESIGNER_MESSAGE.flushed:
      // Anything but an explicit `unsaved: false` counts as unsaved.
      return {
        type: DESIGNER_MESSAGE.flushed,
        saved: fields.saved === true,
        unsaved: fields.unsaved !== false,
      };
    case DESIGNER_MESSAGE.error:
      return {
        type: DESIGNER_MESSAGE.error,
        reason: typeof fields.reason === "string" ? fields.reason.slice(0, 50) : "unknown",
        message:
          typeof fields.message === "string" && fields.message.trim()
            ? fields.message.trim().slice(0, 500)
            : "The editor hit an error.",
      };
    default:
      return null;
  }
}
