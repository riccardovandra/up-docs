import { displayName } from "../../shared/access.ts";
import { api } from "../api.ts";
import { setMe, useMe } from "../me.ts";
import { navigate } from "../router.ts";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "./Menu.tsx";

const initials = (name: string) => {
  const words = name.match(/[\p{L}\p{N}]+/gu) ?? [];
  const letters = words.length > 1 ? [words[0]![0], words.at(-1)![0]] : [words[0]?.[0]];
  return letters.filter(Boolean).join("").toUpperCase() || "?";
};

/** The avatar at the top right: who is signed in, Settings, Sign out. */
export function AccountMenu() {
  const me = useMe();
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
            <MenuItem onSelect={() => void signOut()}>Sign out</MenuItem>
          </>
        )}
      </Menu>
    </div>
  );
}
