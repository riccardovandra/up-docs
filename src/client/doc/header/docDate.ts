const FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

/** "16 Oct 2026", in the reader's time zone. */
export const formatDocDate = (epochMs: number) => FORMAT.format(epochMs);
