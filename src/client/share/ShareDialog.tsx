import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from "react";

import type { DocMember, DocRole, UserSummary } from "../../shared/access.ts";
import { PUBLIC_ORIGIN_META } from "../../shared/embed.ts";
import { api, ApiError } from "../api.ts";
import { useMe } from "../me.ts";
import { leaveDoc } from "../openTabs.ts";
import { docPath } from "../router.ts";
import { MemberRow } from "./MemberRow.tsx";
import { RoleMenu } from "./RoleMenu.tsx";
import { ShareExportTab } from "./ShareExportTab.tsx";
import {
  completeEmail,
  inviteRoles,
  memberControls,
  parseEmails,
  shareErrorText,
  suggestPeople,
} from "./shareLogic.ts";

/** The doc's public address. Inside T3 Code the page may be served from another origin. */
export function canonicalDocUrl(docId: string): string {
  const origin =
    document.querySelector(`meta[name="${PUBLIC_ORIGIN_META}"]`)?.getAttribute("content") ||
    window.location.origin;
  return `${origin}${docPath(docId)}`;
}

const errorCode = (cause: unknown) => (cause instanceof ApiError ? cause.body.error : undefined);

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), [href], [tabindex]";

type Person = Pick<UserSummary, "name" | "email">;

/** The Share popover. Mounted only while open, so members load each time it opens. */
export function ShareDialog(props: {
  readonly docId: string;
  readonly title: string;
  readonly role: DocRole;
  readonly tabId: string | null;
  readonly flush: () => Promise<void>;
  /** The button and panel: clicks inside either do not close it. */
  readonly anchor: RefObject<HTMLElement | null>;
  /** `restoreFocus` is false when the user clicked elsewhere, so focus stays there. */
  readonly onClose: (restoreFocus: boolean) => void;
}) {
  const { docId, onClose } = props;
  const me = useMe();
  const meId = me?.user.id ?? "";
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const listboxId = useId();
  const [view, setView] = useState<"share" | "export">("share");
  const [members, setMembers] = useState<ReadonlyArray<DocMember> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [people, setPeople] = useState<ReadonlyArray<Person>>([]);
  const [query, setQuery] = useState("");
  const [inviteRole, setInviteRole] = useState<DocRole>("editor");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rowError, setRowError] = useState<{ memberId: string; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // The caller's own row is the truth once loaded: they may have just changed it.
  const callerRole = members?.find((member) => member.user?.id === meId)?.role ?? props.role;
  const roles = inviteRoles(callerRole);
  const canInvite = roles.length > 0;

  useEffect(() => {
    let live = true;
    api.members(docId).then(
      (result) => live && setMembers(result.members),
      () => live && setLoadError("Could not load who has access. Close and try again."),
    );
    return () => {
      live = false;
    };
  }, [docId]);

  useEffect(() => {
    if (!canInvite) return;
    let live = true;
    // Suggestions are a nicety; the picker works without them.
    api.people().then(
      (result) => live && setPeople(result.people),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [canInvite]);

  useEffect(() => {
    const root = panel.current;
    (
      root?.querySelector<HTMLElement>("input") ??
      root?.querySelector<HTMLElement>("[role=tab][aria-selected=true]")
    )?.focus();
  }, []);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!props.anchor.current?.contains(event.target as Node)) onClose(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [props.anchor, onClose]);

  const suggestions = members ? suggestPeople(query, people, members) : [];
  const listOpen = suggestions.length > 0 && !suggestionsDismissed;

  const pick = (person: Person) => {
    setQuery(completeEmail(query, person.email));
    setActiveSuggestion(-1);
    setInviteError(null);
  };

  const invite = async () => {
    if (!members || busy) return;
    const parsed = parseEmails(query, members);
    if (parsed.invalid.length > 0) {
      setInviteError(`Not an email address: ${parsed.invalid.join(", ")}`);
      return;
    }
    if (parsed.valid.length === 0) {
      setInviteError(
        parsed.existing.length > 0
          ? `${parsed.existing.join(", ")} already ${parsed.existing.length > 1 ? "have" : "has"} access.`
          : "Enter an email address.",
      );
      return;
    }
    setBusy(true);
    setInviteError(null);
    const remaining = [...parsed.valid];
    try {
      while (remaining.length > 0) {
        const result = await api.shareDoc(docId, { email: remaining[0]!, role: inviteRole });
        setMembers(result.members);
        remaining.shift();
      }
      setQuery("");
    } catch (cause) {
      // Keep what did not go through, so a retry does not resend the rest.
      setQuery(remaining.join(", "));
      setInviteError(`${remaining[0]}: ${shareErrorText(errorCode(cause))}`);
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (member: DocMember, role: DocRole) => {
    setBusy(true);
    setRowError(null);
    try {
      setMembers((await api.setMemberRole(docId, member.id, role)).members);
    } catch (cause) {
      setRowError({ memberId: member.id, text: shareErrorText(errorCode(cause)) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (member: DocMember) => {
    const leaving = member.user?.id === meId;
    setBusy(true);
    setRowError(null);
    try {
      const result = await api.removeMember(docId, member.id);
      if (leaving) {
        // Without access the doc page cannot load anymore.
        leaveDoc(docId);
        return;
      }
      setMembers(result.members);
    } catch (cause) {
      setRowError({ memberId: member.id, text: shareErrorText(errorCode(cause)) });
    } finally {
      setBusy(false);
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(canonicalDocUrl(docId));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const onPanelKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose(true);
      return;
    }
    if (event.key !== "Tab" || !panel.current) return;
    const focusable = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (element) => element.tabIndex >= 0,
    );
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (listOpen && event.key === "ArrowDown") {
      event.preventDefault();
      setActiveSuggestion((index) => (index + 1) % suggestions.length);
    } else if (listOpen && event.key === "ArrowUp") {
      event.preventDefault();
      setActiveSuggestion((index) => (index <= 0 ? suggestions.length - 1 : index - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const picked = suggestions[activeSuggestion];
      if (listOpen && picked) pick(picked);
      else void invite();
    } else if (event.key === "Escape" && listOpen) {
      // First Escape closes the suggestions, the next closes the panel.
      event.stopPropagation();
      setSuggestionsDismissed(true);
      setActiveSuggestion(-1);
    }
  };

  const switchView = (next: "share" | "export") => {
    setView(next);
    document.getElementById(`${titleId}-${next}`)?.focus();
  };

  return (
    <div
      ref={panel}
      className="share-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={onPanelKeyDown}
    >
      <div className="share-head">
        <h2 className="share-title" id={titleId}>
          {props.title}
        </h2>
        <button
          type="button"
          className="share-icon-button"
          aria-label="Close"
          onClick={() => onClose(true)}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>
      </div>

      <div
        className="share-segments"
        role="tablist"
        aria-label="Share or export"
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            switchView(view === "share" ? "export" : "share");
          }
        }}
      >
        {(["share", "export"] as const).map((segment) => (
          <button
            key={segment}
            id={`${titleId}-${segment}`}
            type="button"
            role="tab"
            aria-selected={view === segment}
            tabIndex={view === segment ? 0 : -1}
            onClick={() => switchView(segment)}
          >
            {segment === "share" ? "Share" : "Export"}
          </button>
        ))}
      </div>

      {view === "export" ? (
        <ShareExportTab
          docId={docId}
          tabId={props.tabId}
          flush={props.flush}
          title={props.title}
          onInvite={() => switchView("share")}
          onCopyLink={() => void copyLink()}
          copied={copied}
        />
      ) : (
        <>
          {canInvite ? (
            <div className="share-invite">
              <div className="share-invite-row">
                <input
                  className="share-input"
                  type="text"
                  inputMode="email"
                  autoComplete="off"
                  placeholder="Add people by email"
                  aria-label="Add people by email"
                  role="combobox"
                  aria-expanded={listOpen}
                  aria-controls={listboxId}
                  aria-autocomplete="list"
                  aria-activedescendant={
                    listOpen && activeSuggestion >= 0
                      ? `${listboxId}-${activeSuggestion}`
                      : undefined
                  }
                  aria-invalid={inviteError !== null}
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setActiveSuggestion(-1);
                    setSuggestionsDismissed(false);
                    setInviteError(null);
                  }}
                  onKeyDown={onInputKeyDown}
                />
                {query.trim() ? (
                  <>
                    <RoleMenu
                      role={inviteRole}
                      roles={roles}
                      label="Role for new people"
                      onSelect={setInviteRole}
                    />
                    <button
                      type="button"
                      className="button small"
                      disabled={busy}
                      onClick={() => void invite()}
                    >
                      Invite
                    </button>
                  </>
                ) : null}
              </div>
              {listOpen ? (
                <ul className="share-suggestions" id={listboxId} role="listbox">
                  {suggestions.map((person, index) => (
                    <li
                      key={person.email}
                      id={`${listboxId}-${index}`}
                      role="option"
                      aria-selected={index === activeSuggestion}
                      // Keeps focus in the input, so typing can continue after a pick.
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={() => pick(person)}
                    >
                      <span>{person.name || person.email}</span>
                      {person.name ? <span className="muted">{person.email}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {inviteError ? (
                <p className="share-error" role="alert">
                  {inviteError}
                </p>
              ) : null}
            </div>
          ) : null}

          <h3 className="share-section-label">People with access</h3>
          {loadError ? (
            <p className="share-error" role="alert">
              {loadError}
            </p>
          ) : members === null ? (
            <p className="muted share-status">Loading…</p>
          ) : (
            <ul className="share-members">
              {members.map((member) => (
                <MemberRow
                  key={member.id}
                  member={member}
                  controls={memberControls(member, members, callerRole, meId)}
                  isYou={member.user?.id === meId}
                  busy={busy}
                  error={rowError?.memberId === member.id ? rowError.text : null}
                  onRole={(role) => void changeRole(member, role)}
                  onRemove={() => void remove(member)}
                />
              ))}
            </ul>
          )}
        </>
      )}

      {/* The Export segment carries its own Copy link card. */}
      {view === "share" ? (
        <div className="share-foot">
          <span className="muted">Only people with access can open this link</span>
          <button type="button" className="button secondary small" onClick={() => void copyLink()}>
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
