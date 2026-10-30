import type { ReactNode } from "react";

/** 16px line icons drawn in the current text colour. */
function Icon(props: { readonly children: ReactNode; readonly size?: number }) {
  const size = props.size ?? 16;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {props.children}
    </svg>
  );
}

export const ChevronDown = () => (
  <Icon size={12}>
    <path d="M4 6l4 4 4-4" />
  </Icon>
);

export const DrawIcon = () => (
  <Icon>
    <path d="M11.5 2.5l2 2L6 12l-3 1 1-3z" />
    <path d="M3 13.5c2.5-1 4 1 6.5 0" />
  </Icon>
);

export const WidthIcon = () => (
  <Icon>
    <path d="M2 8h12M4.5 5.5L2 8l2.5 2.5M11.5 5.5L14 8l-2.5 2.5" />
  </Icon>
);

export const TableIcon = () => (
  <Icon>
    <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
    <path d="M2 6h12M2 9.5h12M6 6v7.5M10 6v7.5" />
  </Icon>
);

export const ImageIcon = () => (
  <Icon>
    <rect x="2" y="2.5" width="12" height="11" rx="2" />
    <circle cx="10.5" cy="5.8" r="1.1" />
    <path d="M2.5 12l3.5-3.5 2.5 2.5 1.5-1.5 3.5 3" />
  </Icon>
);

export const ChecklistIcon = () => (
  <Icon>
    <path d="M2 4l1.3 1.3L5.5 3M2 10.5h3.5v3H2z M8 4.2h6M8 12h6" />
  </Icon>
);

export const PlusIcon = () => (
  <Icon>
    <path d="M8 2.5v11M2.5 8h11" />
  </Icon>
);

export const CommentIcon = () => (
  <Icon size={18}>
    <path d="M8 2.5c3.3 0 5.5 2.1 5.5 5s-2.2 5-5.5 5c-.9 0-1.8-.2-2.6-.5L2.5 13l.8-2.7C2.8 9.5 2.5 8.6 2.5 7.5c0-2.9 2.2-5 5.5-5z" />
  </Icon>
);

export const CalendarIcon = () => (
  <Icon size={14}>
    <rect x="2.5" y="3" width="11" height="10.5" rx="1.5" />
    <path d="M2.5 6.5h11M5.5 1.8v2.4M10.5 1.8v2.4" />
  </Icon>
);

/** Claude's spark, filled in the accent colour. */
export const SparkIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" className="spark-icon">
    <path
      d="M8 1l1.2 4.3L13 3l-2.3 3.8L15 8l-4.3 1.2L13 13l-3.8-2.3L8 15l-1.2-4.3L3 13l2.3-3.8L1 8l4.3-1.2L3 3l3.8 2.3z"
      fill="currentColor"
    />
  </svg>
);

export const CodeIcon = () => (
  <Icon>
    <path d="M5.5 4L2 8l3.5 4M10.5 4L14 8l-3.5 4" />
  </Icon>
);

export const ListIcon = () => (
  <Icon>
    <path d="M6 4h8M6 8h8M6 12h8" />
    <circle cx="2.8" cy="4" r=".6" />
    <circle cx="2.8" cy="8" r=".6" />
    <circle cx="2.8" cy="12" r=".6" />
  </Icon>
);

export const LinkIcon = () => (
  <Icon>
    <path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.3-2.3a2.6 2.6 0 0 0-3.7-3.7l-.9.9" />
    <path d="M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.2 9.1a2.6 2.6 0 0 0 3.7 3.7l.9-.9" />
  </Icon>
);
