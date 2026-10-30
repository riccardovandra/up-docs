import type { DocRoom } from "./docRoom.ts";

export interface Env {
  readonly DB: D1Database;
  readonly DOC_ROOM: DurableObjectNamespace<DocRoom>;
  readonly ASSETS: Fetcher;
  /** Doc images, keyed `images/<docId>/<uuid>.<ext>`. Unset: they are stored in D1. */
  readonly IMAGES?: R2Bucket;
  /** Comma-separated; every address signs in as the one admin user, who owns all pre-sharing data. */
  readonly OWNER_EMAILS?: string;
  /** Sender of every email, such as `UP Docs <docs@example.com>`. Unset means no email. */
  readonly EMAIL_FROM?: string;
  /** Where the app is served, such as `https://docs.example.com`. Unset: the request's origin. */
  readonly PUBLIC_ORIGIN?: string;
  /** CSP host-sources (space-separated) allowed to frame the app: the T3 Code clients. */
  readonly FRAME_ANCESTORS?: string;
  /** Unset, or no EMAIL_FROM, means no email: sign-in codes go to the console in local dev and nowhere otherwise. */
  readonly RESEND_API_KEY?: string;
  /** Signs in as the admin. Unset, or under 12 characters, turns password sign-in off. */
  readonly ADMIN_PASSWORD?: string;
}

/** The base of every URL the app hands out. A blank or malformed PUBLIC_ORIGIN counts as unset. */
export function resolvePublicOrigin(configured: string | undefined, requestUrl: string): string {
  const value = configured?.trim();
  return new URL(value && URL.canParse(value) ? value : requestUrl).origin;
}
