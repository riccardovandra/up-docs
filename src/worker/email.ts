import type { EmailDelivery } from "../shared/access.ts";
import type { Env } from "./env.ts";

const RESEND_TIMEOUT_MS = 10_000;

/** Local dev only: the one place a sign-in code may be printed. */
export function isLocalRequest(request: Request): boolean {
  const { hostname } = new URL(request.url);
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export const emailEnabled = (env: Env, local: boolean) => Boolean(env.RESEND_API_KEY) || local;

/**
 * Sends through Resend. With no key, local dev logs the message and anywhere
 * else nothing is sent or logged, because the message can hold a sign-in code.
 * Failures log no part of the message, for the same reason.
 */
async function sendEmail(
  env: Env,
  local: boolean,
  message: { readonly to: string; readonly subject: string; readonly text: string },
): Promise<EmailDelivery> {
  if (!env.RESEND_API_KEY) {
    if (!local) return "not_configured";
    console.log(`[up-docs] email to ${message.to}: ${message.subject}\n${message.text}`);
    return "sent";
  }
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      }),
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    });
    if (response.ok) return "sent";
    console.error(`[up-docs] Resend rejected an email: ${response.status}`);
  } catch {
    console.error("[up-docs] Resend could not be reached");
  }
  return "failed";
}

export function sendLoginCode(
  env: Env,
  local: boolean,
  email: string,
  code: string,
): Promise<EmailDelivery> {
  return sendEmail(env, local, {
    to: email,
    subject: `Your UP Docs sign-in code: ${code}`,
    text: `Your sign-in code is ${code}. It expires in 10 minutes.\n\nIf you did not ask for it, ignore this email.`,
  });
}

export interface DocInvite {
  readonly to: string;
  readonly inviterName: string;
  readonly docTitle: string;
  readonly url: string;
}

export function sendDocInvite(env: Env, local: boolean, invite: DocInvite): Promise<EmailDelivery> {
  return sendEmail(env, local, {
    to: invite.to,
    subject: `${invite.inviterName} shared "${invite.docTitle}" with you`,
    text: `${invite.inviterName} shared "${invite.docTitle}" with you.\n\nOpen it: ${invite.url}\n\nSign in with this email address (${invite.to}) to get a one-time code.`,
  });
}
