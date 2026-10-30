import type { DocRoom } from "./docRoom.ts";

export interface Env {
  readonly DB: D1Database;
  readonly DOC_ROOM: DurableObjectNamespace<DocRoom>;
  readonly ASSETS: Fetcher;
  /** Doc images, keyed `images/<docId>/<uuid>.<ext>`. */
  readonly IMAGES: R2Bucket;
  /** Comma-separated; every address signs in as the one admin user, who owns all pre-sharing data. */
  readonly OWNER_EMAILS: string;
  readonly EMAIL_FROM: string;
  /** Where the app is served, such as `https://docs.example.com`. Local dev overrides it. */
  readonly PUBLIC_ORIGIN: string;
  /** CSP host-sources (space-separated) allowed to frame the app: the T3 Code clients. */
  readonly FRAME_ANCESTORS?: string;
  /** Unset in local dev: sign-in codes are logged to the console instead. */
  readonly RESEND_API_KEY?: string;
}
