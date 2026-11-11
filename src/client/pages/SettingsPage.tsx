import { useCallback, useEffect, useState, type FormEvent } from "react";

import { isAdmin } from "../../shared/access.ts";
import type { ApiTokenSummary } from "../../shared/protocol.ts";
import { api } from "../api.ts";
import { isEmbedded } from "../embedBridge.ts";
import { AccountMenu } from "../home/AccountMenu.tsx";
import { HomeLink } from "../home/HomeLink.tsx";
import { setMe, useMe } from "../me.ts";
import { setAppearance, storedAppearance, type Appearance } from "../theme.ts";
import { DiagramThemeSettings } from "./DiagramThemeSettings.tsx";
import { ProjectSettings } from "./ProjectSettings.tsx";

const APPEARANCES: ReadonlyArray<readonly [Appearance, string]> = [
  ["system", "System"],
  ["light", "Light"],
  ["dark", "Dark"],
];

export function SettingsPage() {
  const me = useMe();
  const [displayName, setDisplayName] = useState(me?.user.name ?? "");
  const [nameSaved, setNameSaved] = useState(false);
  const [tokens, setTokens] = useState<ReadonlyArray<ApiTokenSummary>>([]);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [appearance, setChosenAppearance] = useState(storedAppearance);

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
      <h2>Appearance</h2>
      {isEmbedded() ? (
        <p className="muted">T3 Code sets the appearance here. Change it in T3 Code&apos;s settings.</p>
      ) : (
        <>
          <p className="muted">System follows your device&apos;s light or dark mode.</p>
          <div className="inline-form" role="group" aria-label="Appearance">
            {APPEARANCES.map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={appearance === value ? "button" : "button secondary"}
                aria-pressed={appearance === value}
                onClick={() => {
                  setAppearance(value);
                  setChosenAppearance(value);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}
      {me && isAdmin(me.user.id) ? (
        <>
          <h2>Projects</h2>
          <p className="muted">
            Rename a project, move its docs elsewhere, or delete it. A project is deleted only once
            it holds no docs. T3 Code renames projects it syncs to their T3 Code title, and filing
            a doc under a deleted project&apos;s key creates it again.
          </p>
          <ProjectSettings />
        </>
      ) : null}
      <h2>Diagram themes</h2>
      <p className="muted">
        Colours, fonts and box and arrow styles for Draw.io diagrams. New shapes start in a
        diagram&apos;s theme, and Restyle with theme on a diagram&apos;s page applies it to what is
        drawn. Your custom themes are yours; the built-ins can be duplicated.
      </p>
      <DiagramThemeSettings admin={me !== null && isAdmin(me.user.id)} />
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
