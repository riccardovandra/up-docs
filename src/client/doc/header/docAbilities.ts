import { canComment, canEdit, type DocRole } from "../../../shared/access.ts";

/** What the doc page offers someone with `role`; the server checks every write again. */
export interface DocAbilities {
  /** Type in the editor, use the insert toolbar, upload images. */
  readonly edit: boolean;
  /** Start comment threads, reply and resolve. */
  readonly comment: boolean;
  /** Rename the doc and change its status. */
  readonly manageDoc: boolean;
  /** Add, rename, move and delete tabs. */
  readonly manageTabs: boolean;
  readonly deleteDoc: boolean;
  /** "Start chat" hands the doc to T3 Code, which links the new thread: an editor's write. */
  readonly startChat: boolean;
}

export function docAbilities(
  role: DocRole,
  context: { readonly startWorkAvailable: boolean },
): DocAbilities {
  const edit = canEdit(role);
  return {
    edit,
    comment: canComment(role),
    manageDoc: edit,
    manageTabs: edit,
    deleteDoc: role === "owner",
    startChat: edit && context.startWorkAvailable,
  };
}
