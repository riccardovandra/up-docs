// Turns a diagram's standalone SVG into a PNG on the clipboard, so it pastes
// into Slack, email or slides like any screenshot.

/** Pixels per SVG unit: sharp on retina screens without huge files. */
const SCALE = 2;

/** Draws the SVG on an opaque background and returns it as a PNG. */
export async function svgToPng(svg: string, background: string): Promise<Blob> {
  const image = new Image();
  // A blob URL: the page's CSP allows img-src 'self' blob:, not data:.
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  image.src = url;
  try {
    await image.decode();
  } finally {
    URL.revokeObjectURL(url);
  }
  const width = image.naturalWidth || 760;
  const height = image.naturalHeight || 280;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * SCALE);
  canvas.height = Math.round(height * SCALE);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("No 2D canvas.");
  context.fillStyle = background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("The image could not be made."))),
      "image/png",
    ),
  );
}

/**
 * Writes the PNG to the clipboard. Call straight from a click: the clipboard
 * gets the promise before any await, which keeps Safari's user activation.
 */
export async function copyPng(png: Promise<Blob>): Promise<void> {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
    throw new Error("This browser cannot copy images.");
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

/** The fallback when the clipboard refuses: save the PNG instead. */
export function downloadPng(png: Blob, name: string): void {
  const url = URL.createObjectURL(png);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name || "diagram"}.png`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
