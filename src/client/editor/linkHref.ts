/** Links typed without a scheme open as https; anything but web and mail links is refused. */
export function linkHref(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  const href = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  return /^(https?|mailto):/i.test(href) ? href : null;
}
