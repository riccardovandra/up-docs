import { useMediaQuery } from "../comments/useMediaQuery.ts";

/**
 * A phone or tablet: a touch screen with no mouse or trackpad. Diagrams there
 * are for reading: pages, pinch zoom and comments work, but nothing opens the
 * Draw.io editor and nothing changes the diagram itself.
 */
export const VIEW_ONLY_DEVICE_QUERY = "(hover: none) and (pointer: coarse)";

/** Whether this device may change diagrams (open Draw.io, rename, delete, theme). */
export function useDiagramChanges(): boolean {
  return !useMediaQuery(VIEW_ONLY_DEVICE_QUERY);
}
