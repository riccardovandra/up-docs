import type { Env } from "./env.ts";

/** Sends through Resend, or logs the message when no key is configured (local dev). */
async function sendEmail(
  env: Env,
  message: { readonly to: string; readonly subject: string; readonly text: string },
): Promise<void> {
  if (!env.RESEND_API_KEY) {
    console.log(`[up-docs] email to ${message.to}: ${message.subject}\n${message.text}`);
    return;
  }
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
  });
  if (!response.ok) {
    console.error(`[up-docs] Resend rejected "${message.subject}": ${response.status}`);
  }
}

export function sendLoginCode(env: Env, email: string, code: string): Promise<void> {
  return sendEmail(env, {
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

export function sendDocInvite(env: Env, invite: DocInvite): Promise<void> {
  return sendEmail(env, {
    to: invite.to,
    subject: `${invite.inviterName} shared "${invite.docTitle}" with you`,
    text: `${invite.inviterName} shared "${invite.docTitle}" with you.\n\nOpen it: ${invite.url}\n\nSign in with this email address (${invite.to}) to get a one-time code.`,
  });
}
