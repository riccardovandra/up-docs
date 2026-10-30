import type { DocMember, DocRole } from "../../shared/access.ts";
import { RoleMenu } from "./RoleMenu.tsx";
import { initials, memberLabel, type MemberControls } from "./shareLogic.ts";

export function MemberRow(props: {
  readonly member: DocMember;
  readonly controls: MemberControls;
  readonly isYou: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onRole: (role: DocRole) => void;
  readonly onRemove: () => void;
}) {
  const { member, controls } = props;
  const name = memberLabel(member);
  const removal =
    controls.removal === "leave"
      ? { label: "Leave", run: props.onRemove }
      : controls.removal === "remove"
        ? { label: "Remove", run: props.onRemove }
        : undefined;
  return (
    <li className="share-member">
      <div className="share-member-main">
        <span className="share-avatar" aria-hidden="true">
          {initials(member)}
        </span>
        <span className="share-member-text">
          <span className="share-member-name">
            {member.pending ? member.email : name}
            {props.isYou ? <span className="muted"> (you)</span> : null}
          </span>
          <span className="share-member-email muted">
            {member.pending ? "Invited, not signed in yet" : member.email}
          </span>
        </span>
        <RoleMenu
          role={member.role}
          roles={controls.roles}
          label={`Access for ${name}`}
          disabled={props.busy}
          onSelect={props.onRole}
          action={removal}
        />
      </div>
      {props.error ? (
        <p className="share-error" role="alert">
          {props.error}
        </p>
      ) : null}
    </li>
  );
}
