import { personLabel, presenceColor, type PresenceAvatar } from "./presence.ts";

/** Avatars shown before the rest collapse into "+N". */
const MAX_SHOWN = 5;

const initials = (name: string) => {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0]!.charAt(0);
  const last = words.length > 1 ? words.at(-1)!.charAt(0) : "";
  return (first + last).toUpperCase();
};

/** Who has the sheet open, for the top bar: one circle per person, the name on hover. */
export function PresenceAvatars(props: { readonly avatars: ReadonlyArray<PresenceAvatar> }) {
  const { avatars } = props;
  if (avatars.length < 2) return null;
  const shown = avatars.slice(0, MAX_SHOWN);
  const rest = avatars.slice(MAX_SHOWN);
  const title = (avatar: PresenceAvatar) => `${personLabel(avatar.name)}${avatar.self ? " (you)" : ""}`;
  return (
    <ul className="sheet-avatars" aria-label="People in this sheet">
      {shown.map((avatar) => (
        <li
          key={avatar.userId}
          className="sheet-avatar"
          title={title(avatar)}
          aria-label={title(avatar)}
          style={{ background: presenceColor(avatar.colorIndex) }}
        >
          {initials(avatar.name)}
        </li>
      ))}
      {rest.length > 0 ? (
        <li className="sheet-avatar sheet-avatar-more" title={rest.map(title).join(", ")}>
          +{rest.length}
        </li>
      ) : null}
    </ul>
  );
}
