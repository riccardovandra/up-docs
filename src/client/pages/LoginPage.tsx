import { useEffect, useState, type FormEvent } from "react";

import type { Me } from "../../shared/access.ts";
import { api, ApiError } from "../api.ts";

type Config = Awaited<ReturnType<typeof api.authConfig>>;

const PASSWORD_ERROR_TEXT: Readonly<Record<string, string>> = {
  invalid_password: "That password is not correct.",
  too_many_attempts: "Too many attempts. Try again in 15 minutes.",
  password_not_configured:
    "Password sign-in is off. Set the ADMIN_PASSWORD secret to at least 12 characters.",
};

export function LoginPage(props: { readonly onSignedIn: (me: Me) => void }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api.authConfig().then(
      (result) => live && setConfig(result),
      () => live && setError("Could not reach the server. Reload to try again."),
    );
    return () => {
      live = false;
    };
  }, []);

  const submitPassword = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.signInWithPassword(password);
      props.onSignedIn(await api.me());
    } catch (cause) {
      const code = cause instanceof ApiError ? cause.body.error : undefined;
      setError((code && PASSWORD_ERROR_TEXT[code]) || "Could not sign in. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const submitEmail = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.requestCode(email);
      setStep("code");
    } catch {
      setError("Could not send a code. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.verifyCode(email, code);
      props.onSignedIn(await api.me());
    } catch {
      setError("That code is not valid. Check it or request a new one.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <h1>UP Docs</h1>
      {config?.passwordEnabled && step === "email" ? (
        <form onSubmit={submitPassword} className="stack">
          <p className="muted">Admin? Sign in with the password set during deploy.</p>
          <label htmlFor="password">Admin password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <button type="submit" className="button" disabled={busy}>
            Sign in
          </button>
        </form>
      ) : null}
      {config?.emailEnabled ? (
        step === "email" ? (
          <form onSubmit={submitEmail} className="stack">
            <p className="muted">Sign in with the email a doc was shared with.</p>
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              autoFocus={!config.passwordEnabled}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <button type="submit" className="button" disabled={busy}>
              Send sign-in code
            </button>
          </form>
        ) : (
          <form onSubmit={submitCode} className="stack">
            <p className="muted">If {email} has access, a 6-digit code is on its way.</p>
            <label htmlFor="code">Code</label>
            <input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              required
              autoFocus
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
            <button type="submit" className="button" disabled={busy}>
              Sign in
            </button>
            <button type="button" className="link-button" onClick={() => setStep("email")}>
              Use a different email
            </button>
          </form>
        )
      ) : null}
      {config && !config.passwordEnabled ? (
        <p className="muted">
          {config.emailEnabled
            ? "Admin password sign-in is off. To turn it on, set the ADMIN_PASSWORD secret to at least 12 characters."
            : "Sign-in is not set up yet. Set the ADMIN_PASSWORD secret to at least 12 characters, then reload this page."}
        </p>
      ) : null}
      {config?.passwordEnabled && !config.emailEnabled ? (
        <p className="muted">
          Email sign-in is off, so only the admin can sign in. Set the RESEND_API_KEY secret to turn
          it on.
        </p>
      ) : null}
      {error ? <p className="error">{error}</p> : null}
    </main>
  );
}
