import { AUTOSAVE_DELAY_MS } from "../doc/tabSaver.ts";
import type { DocSnapshot, DocSource } from "./docSource.ts";

/**
 * Debounced autosave over a `DocSource`, the counterpart of `TabSaver`. One
 * save is in flight at a time and each names the version the editor last
 * saw. A conflict drops the pending edit and hands back what the source has
 * now, so the page shows it instead of overwriting it.
 */
export class DocSaver {
  private draft: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private baseVersion: string;
  private readonly source: DocSource;
  private readonly callbacks: {
    readonly onSaved: (version: string) => void;
    readonly onConflict: (current: DocSnapshot) => void;
    /** The save failed; the edit is kept and retried. */
    readonly onError: (cause: unknown) => void;
  };

  constructor(source: DocSource, baseVersion: string, callbacks: DocSaver["callbacks"]) {
    this.source = source;
    this.baseVersion = baseVersion;
    this.callbacks = callbacks;
  }

  get dirty(): boolean {
    return this.draft !== null || this.inFlight;
  }

  /** An edit is waiting for its save to start. */
  get pending(): boolean {
    return this.draft !== null;
  }

  /** A newer text the editor has adopted. */
  acceptRemote(version: string): void {
    this.baseVersion = version;
  }

  schedule(markdown: string): void {
    this.draft = markdown;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), AUTOSAVE_DELAY_MS);
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.inFlight || this.draft === null) return;
    const markdown = this.draft;
    this.draft = null;
    this.inFlight = true;
    try {
      const result = await this.source.save(markdown, this.baseVersion);
      if (result.status === "saved") {
        this.baseVersion = result.version;
        this.callbacks.onSaved(result.version);
      } else {
        // Edits typed meanwhile were based on the old text too.
        this.draft = null;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.baseVersion = result.current.version;
        this.callbacks.onConflict(result.current);
      }
    } catch (cause) {
      this.draft ??= markdown;
      this.timer = setTimeout(() => void this.flush(), AUTOSAVE_DELAY_MS * 4);
      this.callbacks.onError(cause);
    } finally {
      this.inFlight = false;
    }
    if (this.draft !== null && !this.timer) await this.flush();
  }
}
