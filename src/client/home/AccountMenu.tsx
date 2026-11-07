import { useState } from "react";

import { displayName } from "../../shared/access.ts";
import { api } from "../api.ts";
import { isEmbedded } from "../embedBridge.ts";
import { setMe, useMe } from "../me.ts";
import { navigate } from "../router.ts";
import { setAppearance, storedAppearance, type Appearance } from "../theme.ts";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "./Menu.tsx";

const APPEARANCES: ReadonlyArray<readonly [Appearance, string]> = [
  ["system", "System"],
  ["light", "Light"],
  ["dark", "Dark"],
];

const initials = (name: string) => {
  const words = name.match(/[\p{L}\p{N}]+/gu) ?? [];
  const letters = words.length > 1 ? [words[0]![0], words.at(-1)![0]] : [words[0]?.[0]];
  return letters.filter(Boolean).join("").toUpperCase() || "?";
};

/**
 * The avatar at the top right: who is signed in, Settings, the appearance
 * (standalone only; T3 Code sets it when it embeds this app), Sign out.
 */
export function AccountMenu() {
  const me = useMe();
  // Re-renders the menu after a pick; the saved value is read on each render so
  // a change made on the Settings page shows here too.
  const [, setChosen] = useState(storedAppearance);
  if (!me) return null;
  const name = displayName(me.user);
  const signOut = async () => {
    await api.logout();
    setMe(null);
    navigate("/", { replace: true });
  };
  return (
    <div className="account-menu">
      <Menu
        label="Account"
        triggerClassName="account-avatar"
        trigger={<span aria-hidden="true">{initials(name)}</span>}
      >
        {(close) => (
          <>
            <MenuLabel>
              <span className="account-name">{me.user.name.trim() || "Signed in"}</span>
              <span className="account-email">{me.user.email}</span>
            </MenuLabel>
            <MenuSeparator />
            <MenuItem
              onSelect={() => {
                close();
                navigate("/settings");
              }}
            >
              Settings
            </MenuItem>
            {isEmbedded() ? null : (
              <>
                <MenuSeparator />
                <MenuLabel>Appearance</MenuLabel>
                {APPEARANCES.map(([value, label]) => (
                  <MenuItem
                    key={value}
                    kind="radio"
                    checked={storedAppearance() === value}
                    onSelect={() => {
                      setAppearance(value);
                      setChosen(value);
                    }}
                  >
                    {label}
                  </MenuItem>
                ))}
                <MenuSeparator />
              </>
            )}
            <MenuItem onSelect={() => void signOut()}>Sign out</MenuItem>
          </>
        )}
      </Menu>
    </div>
  );
}
