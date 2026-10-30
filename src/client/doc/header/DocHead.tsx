import { memo } from "react";

import { displayName, type UserSummary } from "../../../shared/access.ts";
import { CalendarIcon } from "../toolbar/icons.tsx";
import { formatDocDate } from "./docDate.ts";

/** The doc's large serif title with its byline: created date and owner. */
export const DocHead = memo(function DocHead(props: {
  readonly title: string;
  readonly createdAt: number;
  readonly owner: UserSummary | null;
}) {
  return (
    <div className="doc-head">
      <h1 className="doc-head-title">{props.title}</h1>
      <p className="doc-byline">
        <span className="byline-chip">
          <CalendarIcon />
          <time dateTime={new Date(props.createdAt).toISOString()}>
            {formatDocDate(props.createdAt)}
          </time>
        </span>
        {props.owner ? (
          <>
            <span className="byline-dot" aria-hidden="true">
              ·
            </span>
            <span className="byline-chip">@{displayName(props.owner)}</span>
          </>
        ) : null}
      </p>
    </div>
  );
});
