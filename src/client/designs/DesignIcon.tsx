/** A design: a pen nib over a frame, on Lucide's 24px grid like the home page's other icons. */
export function DesignIcon(props: { readonly size?: number }) {
  const size = props.size ?? 18;
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
      <path d="m12 7 4 6-4 4-4-4 4-6Z" />
      <path d="M12 7v5" />
    </svg>
  );
}
