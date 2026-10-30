import { useState, type FormEvent } from "react";

import type { Me } from "../../shared/access.ts";
import { api } from "../api.ts";

export function LoginPage(props: { readonly onSignedIn: (me: Me) => void }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      {step === "email" ? (
        <form onSubmit={submitEmail} className="stack">
          <p className="muted">Sign in with the email a doc was shared with.</p>
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            required
            autoFocus
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
      )}
      {error ? <p className="error">{error}</p> : null}
    </main>
  );
}
