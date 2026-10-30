import { useCallback, useEffect, useState, type FormEvent } from "react";

import type { ApiTokenSummary } from "../../shared/protocol.ts";
import { api } from "../api.ts";
import { AccountMenu } from "../home/AccountMenu.tsx";
import { HomeLink } from "../home/HomeLink.tsx";
import { setMe, useMe } from "../me.ts";

export function SettingsPage() {
  const me = useMe();
  const [displayName, setDisplayName] = useState(me?.user.name ?? "");
  const [nameSaved, setNameSaved] = useState(false);
  const [tokens, setTokens] = useState<ReadonlyArray<ApiTokenSummary>>([]);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setTokens((await api.tokens()).tokens);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    const result = await api.createToken(name.trim());
    setCreated(result.token);
    setName("");
    await reload();
  };

  const saveName = async (event: FormEvent) => {
    event.preventDefault();
    setMe(await api.setName(displayName.trim()));
    setNameSaved(true);
  };

  const revoke = async (id: string) => {
    await api.revokeToken(id);
    await reload();
  };

  return (
    <main className="page">
      <div className="settings-bar">
        <HomeLink />
        <AccountMenu />
      </div>
      <h1>Settings</h1>
      <h2>Profile</h2>
      <p className="muted">
        People you share docs with see this name. Signed in as {me?.emails.join(", ")}.
      </p>
      <form onSubmit={saveName} className="inline-form">
        <input
          placeholder="Display name"
          maxLength={100}
          value={displayName}
          onChange={(event) => {
            setDisplayName(event.target.value);
            setNameSaved(false);
          }}
        />
        <button type="submit" className="button">
          Save
        </button>
        {nameSaved ? <span className="muted">Saved</span> : null}
      </form>
      <h2>API tokens</h2>
      <p className="muted">
        Agents and T3 Code use these as <code>Authorization: Bearer …</code> on <code>/api</code>{" "}
        and <code>/mcp</code>.
      </p>
      <form onSubmit={create} className="inline-form">
        <input
          placeholder="Token name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <button type="submit" className="button">
          Create token
        </button>
      </form>
      {created ? (
        <div className="notice">
          <p>Copy this token now. It is not shown again.</p>
          <code className="token">{created}</code>
        </div>
      ) : null}
      <ul className="token-list">
        {tokens.map((token) => (
          <li key={token.id}>
            <span>{token.name}</span>
            <span className="muted">
              Created {new Date(token.createdAt).toLocaleDateString()}
              {token.lastUsedAt
                ? ` · last used ${new Date(token.lastUsedAt).toLocaleString()}`
                : ""}
            </span>
            <button type="button" className="link-button danger" onClick={() => revoke(token.id)}>
              Revoke
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
