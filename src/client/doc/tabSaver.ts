import type { Tab } from "../../shared/protocol.ts";
import { api, ApiError } from "../api.ts";

export const AUTOSAVE_DELAY_MS = 800;

/**
 * Debounced autosave for one tab. One request is in flight at a time and each
 * carries the version the editor last saw; a 409 hands back the current tab so
 * the page can reload it (last-writer conflicts are surfaced, never merged).
 */
export class TabSaver {
  private draft: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  /** Markdown the server refused for an invalid diagram or table; not resent until it changes. */
  private refused: string | null = null;
  private baseVersion: number;
  private readonly tabId: string;
  private readonly callbacks: {
    readonly onSaved: (tab: Tab) => void;
    readonly onConflict: (tab: Tab) => void;
    /** The server refused a diagram; the edit is kept and sent with the next change. */
    readonly onInvalidBlock?: (kind: "diagram" | "table") => void;
  };

  constructor(tabId: string, baseVersion: number, callbacks: TabSaver["callbacks"]) {
    this.tabId = tabId;
    this.baseVersion = baseVersion;
    this.callbacks = callbacks;
  }

  get dirty(): boolean {
    return this.draft !== null || this.inFlight;
  }

  /** A remote write the editor has adopted. */
  acceptRemote(tab: Tab): void {
    if (tab.version > this.baseVersion) this.baseVersion = tab.version;
  }

  schedule(markdown: string): void {
    this.draft = markdown;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), AUTOSAVE_DELAY_MS);
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.inFlight || this.draft === null || this.draft === this.refused) return;
    const markdown = this.draft;
    this.draft = null;
    this.inFlight = true;
    try {
      const { tab } = await api.writeTab(this.tabId, { baseVersion: this.baseVersion, markdown });
      this.baseVersion = tab.version;
      this.callbacks.onSaved(tab);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409 && cause.body.tab) {
        this.draft = null;
        this.baseVersion = cause.body.tab.version;
        this.callbacks.onConflict(cause.body.tab);
      } else if (
        cause instanceof ApiError &&
        (cause.body.error === "widget_invalid" || cause.body.error === "table_invalid")
      ) {
        this.draft ??= markdown;
        this.refused = markdown;
        this.callbacks.onInvalidBlock?.(cause.body.error === "table_invalid" ? "table" : "diagram");
      } else if (cause instanceof ApiError && cause.status === 404) {
        // The tab was deleted; there is nowhere left to save to.
        this.draft = null;
      } else {
        // Keep the edit for the next attempt unless a newer one replaced it.
        this.draft ??= markdown;
        this.timer = setTimeout(() => void this.flush(), AUTOSAVE_DELAY_MS * 4);
      }
    } finally {
      this.inFlight = false;
    }
    if (this.draft !== null && !this.timer) await this.flush();
  }
}
