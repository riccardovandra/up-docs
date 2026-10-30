// Adapted from apps/web/src/components/docs/docCommentLayout.ts.

export const COMMENT_CARD_GAP = 8;

export interface CommentCardSlot {
  readonly id: string;
  /** Where the card's passage starts, relative to the margin. */
  readonly anchorTop: number;
  readonly height: number;
}

/**
 * Places margin cards beside their passages without overlap. The active card
 * sits exactly at its passage; cards above it are pushed up and cards below
 * pushed down.
 */
export function layoutCommentCards(
  slots: ReadonlyArray<CommentCardSlot>,
  activeId: string | null,
): ReadonlyMap<string, number> {
  const sorted = slots.toSorted((a, b) => a.anchorTop - b.anchorTop || a.id.localeCompare(b.id));
  const pivot = Math.max(
    0,
    sorted.findIndex((slot) => slot.id === activeId),
  );
  const tops = new Map<string, number>();
  if (sorted.length === 0) return tops;

  tops.set(sorted[pivot]!.id, Math.max(0, sorted[pivot]!.anchorTop));
  for (let index = pivot + 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]!;
    const slot = sorted[index]!;
    const below = tops.get(previous.id)! + previous.height + COMMENT_CARD_GAP;
    tops.set(slot.id, Math.max(slot.anchorTop, below));
  }
  for (let index = pivot - 1; index >= 0; index -= 1) {
    const next = sorted[index + 1]!;
    const slot = sorted[index]!;
    const above = tops.get(next.id)! - slot.height - COMMENT_CARD_GAP;
    tops.set(slot.id, Math.min(slot.anchorTop, above));
  }
  // Pushing cards up can run past the top edge; shift everything back into view.
  const overflow = Math.min(0, ...tops.values());
  if (overflow < 0) for (const [id, top] of tops) tops.set(id, top - overflow);
  return tops;
}
