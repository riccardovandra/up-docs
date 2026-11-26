// The design page's save queue. The editor sends a whole file on every
// autosave; this stores them one at a time, each made from the version the
// last one produced (`baseVersion`), and keeps only the newest waiting save:
// an older waiting one is superseded, and acknowledged when the newer lands.
// A failed save keeps its bytes so Retry can send them again.

export type SaveStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "saving" }
  | { readonly kind: "saved"; readonly at: number }
  | {
      readonly kind: "failed";
      readonly message: string;
      /** Another tab or agent saved first; Retry stores this file over theirs. */
      readonly conflict: boolean;
    };

export interface PendingSave {
  readonly seq: number;
  readonly fig: ArrayBuffer;
  readonly png: ArrayBuffer | null;
}

export type SaveOutcome =
  | { readonly ok: true; readonly version: number; readonly note?: string }
  | {
      readonly ok: false;
      readonly message: string;
      /** The latest version on the server, when the save was refused as stale. */
      readonly currentVersion?: number;
    };

export interface DesignSaverDeps {
  readonly send: (baseVersion: number, save: PendingSave) => Promise<SaveOutcome>;
  /** Tells the editor saves up to `seq` are stored. */
  readonly ack: (seq: number) => void;
  readonly onStatus: (status: SaveStatus) => void;
  /** A stored save's version, for the header and the picture. */
  readonly onSaved?: (version: number, note: string | undefined) => void;
  readonly now: () => number;
}

export class DesignSaver {
  #baseVersion: number;
  #running = false;
  #waiting: PendingSave | null = null;
  #failed: PendingSave | null = null;
  /** Saves replaced by a newer one: acknowledged once a newer file is stored. */
  #covered: Array<number> = [];
  /** The server's version after a stale refusal: Retry saves on top of it. */
  #conflictVersion: number | null = null;
  #status: SaveStatus = { kind: "idle" };
  readonly #deps: DesignSaverDeps;

  constructor(baseVersion: number, deps: DesignSaverDeps) {
    this.#baseVersion = baseVersion;
    this.#deps = deps;
  }

  get baseVersion(): number {
    return this.#baseVersion;
  }

  get status(): SaveStatus {
    return this.#status;
  }

  /** Whether leaving now would lose a change. */
  get unsaved(): boolean {
    return this.#running || this.#waiting !== null || this.#failed !== null;
  }

  /** A new save from the editor. */
  offer(save: PendingSave): void {
    // A newer file replaces a failed or waiting one: it holds their changes too.
    const superseded = this.#waiting ?? this.#failed;
    if (superseded && superseded.seq < save.seq) this.#covered.push(superseded.seq);
    this.#failed = null;
    this.#waiting = save;
    void this.#run();
  }

  /** Sends the failed save again; after a conflict, on top of the newer version. */
  retry(): void {
    if (!this.#failed) return;
    if (this.#conflictVersion !== null) this.#baseVersion = this.#conflictVersion;
    this.#conflictVersion = null;
    this.#waiting = this.#failed;
    this.#failed = null;
    void this.#run();
  }

  /** After the design was loaded again: later saves build on `version`. */
  rebase(version: number): void {
    this.#baseVersion = version;
    this.#failed = null;
    this.#conflictVersion = null;
    if (!this.#running && !this.#waiting) this.#set({ kind: "idle" });
  }

  #set(status: SaveStatus) {
    this.#status = status;
    this.#deps.onStatus(status);
  }

  async #run(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      while (this.#waiting) {
        const save = this.#waiting;
        this.#waiting = null;
        this.#set({ kind: "saving" });
        let outcome: SaveOutcome;
        try {
          outcome = await this.#deps.send(this.#baseVersion, save);
        } catch {
          outcome = { ok: false, message: "Could not reach UP Docs." };
        }
        if (outcome.ok) {
          this.#baseVersion = outcome.version;
          for (const seq of this.#covered.filter((each) => each < save.seq)) this.#deps.ack(seq);
          this.#covered = this.#covered.filter((each) => each > save.seq);
          this.#deps.ack(save.seq);
          this.#deps.onSaved?.(outcome.version, outcome.note);
          if (!this.#waiting) this.#set({ kind: "saved", at: this.#deps.now() });
          continue;
        }
        if (this.#waiting) {
          // A newer file is already here and holds this one's changes: try that instead.
          this.#covered.push(save.seq);
          if (outcome.currentVersion === undefined) continue;
        }
        if (outcome.currentVersion !== undefined) this.#conflictVersion = outcome.currentVersion;
        const failed = this.#waiting ?? save;
        this.#waiting = null;
        this.#failed = failed;
        this.#set({
          kind: "failed",
          message: outcome.message,
          conflict: outcome.currentVersion !== undefined,
        });
      }
    } finally {
      this.#running = false;
    }
  }
}
