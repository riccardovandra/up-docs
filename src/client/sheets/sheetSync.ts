// The grid's editing model. It keeps the workbook the server confirmed (at
// its revision) and a queue of this page's own edit lists not yet confirmed,
// applied on top so a change shows at once. Lists go to the server one at a
// time against the confirmed revision:
//
//   - a broadcast at `base` == confirmed revision applies to the confirmed
//     workbook, and the pending lists are re-applied on top (a rebase: they are
//     A1 edits, so they apply again to the newer workbook as they stand);
//   - this page's own broadcast, or a 200 for its list, confirms that list;
//   - a 409 waits for the broadcasts up to the server's revision, then resends;
//   - a broadcast past `base` means one was missed: the sheet is fetched again.
//
// No I/O of its own: the page hands it the POST and the GET, so tests drive it.

import type { SheetAuthor, SheetRoomMessage } from "../../shared/sheets.ts";
import { applyEdits, isRefusal } from "../../shared/sheet/workbook.ts";
import type { Applied, Changes, Edit, Refusal, Workbook } from "../../shared/sheet/types.ts";
import type { EditsOutcome } from "./sheetsApi.ts";

/** How long a 409 waits for the broadcasts it is behind before fetching the sheet. */
export const STALE_WAIT_MS = 1500;
const RETRY_MS = [1000, 2000, 5000, 10_000];

interface Pending {
  readonly id: number;
  readonly edits: ReadonlyArray<Edit>;
  /** The base it was last sent with; null while not in flight. */
  sentBase: number | null;
  /** The revision the server applied it at, when that is known before the broadcast. */
  ackedAt: number | null;
}

/** A revision someone else made, as it landed here. */
export interface RemoteChange {
  readonly by: SheetAuthor;
  readonly changed: Changes;
}

export interface SheetSyncDeps {
  readonly clientId: string;
  readonly post: (base: number, edits: ReadonlyArray<Edit>) => Promise<EditsOutcome>;
  /** The sheet as stored now, rebuilt into a workbook. */
  readonly fetch: () => Promise<Workbook>;
  readonly onRemote?: (change: RemoteChange) => void;
  /** The server refused one of this page's lists; it was dropped. */
  readonly onRefused?: (refusal: Refusal) => void;
  /** The sheet is gone, or no longer this person's. */
  readonly onGone?: () => void;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

export class SheetSync {
  private confirmedWorkbook: Workbook;
  private viewWorkbook: Workbook;
  private readonly pending: Pending[] = [];
  private inflight: Pending | null = null;
  private nextId = 1;
  /** After a 409: the revision to catch up to before sending again. */
  private behindUntil = -1;
  private fetching = false;
  private refetchWanted = false;
  /** Broadcasts that came in during a fetch, replayed on top of it. */
  private buffered: Array<Extract<SheetRoomMessage, { type: "sheet.revision" }>> = [];
  /** A retry after a failed POST or fetch; nothing is sent while it runs. */
  private timer: unknown = null;
  /** After a 409: when to stop waiting for broadcasts and fetch. */
  private staleTimer: unknown = null;
  private failures = 0;
  private closed = false;
  private readonly listeners = new Set<() => void>();

  private readonly deps: SheetSyncDeps;

  constructor(workbook: Workbook, deps: SheetSyncDeps) {
    this.deps = deps;
    this.confirmedWorkbook = workbook;
    this.viewWorkbook = workbook;
  }

  /** What the grid shows: the confirmed workbook with this page's pending lists on top. */
  get view(): Workbook {
    return this.viewWorkbook;
  }

  get confirmed(): Workbook {
    return this.confirmedWorkbook;
  }

  /** Lists not yet confirmed by the server. */
  get pendingCount(): number {
    return this.pending.length;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getView = (): Workbook => this.viewWorkbook;

  /**
   * Applies a list here at once and queues it for the server. A refusal (a
   * bad range, a taken tab name) is returned and nothing is queued.
   */
  apply(edits: ReadonlyArray<Edit>): Applied | Refusal {
    const applied = applyEdits(this.viewWorkbook, this.viewWorkbook.revision, edits);
    if (isRefusal(applied)) return applied;
    this.pending.push({ id: this.nextId++, edits, sentBase: null, ackedAt: null });
    this.viewWorkbook = applied.workbook;
    this.emit();
    this.pump();
    return applied;
  }

  /** A message from the sheet room's socket. */
  receive(message: SheetRoomMessage): void {
    if (this.closed || message.type !== "sheet.revision") return;
    if (this.fetching) {
      this.buffered.push(message);
      return;
    }
    this.land(message);
    this.pump();
  }

  /** After the socket came back: broadcasts sent while it was down are not replayed. */
  resync(): void {
    this.refetch();
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) this.clear(this.timer);
    if (this.staleTimer !== null) this.clear(this.staleTimer);
    this.listeners.clear();
  }

  private land(message: Extract<SheetRoomMessage, { type: "sheet.revision" }>): void {
    const confirmed = this.confirmedWorkbook;
    if (message.revision <= confirmed.revision) return;
    const own = message.origin === this.deps.clientId ? this.ownList(message) : null;
    if (message.base !== confirmed.revision) {
      // Missed one. If this is our own list, remember it landed so it is not sent twice.
      if (own) {
        own.ackedAt = message.revision;
        own.sentBase = null;
        if (this.inflight === own) this.inflight = null;
      }
      this.refetch();
      return;
    }
    const applied = applyEdits(confirmed, message.base, message.edits);
    if (isRefusal(applied)) {
      this.refetch();
      return;
    }
    this.confirmedWorkbook = applied.workbook;
    if (own) {
      this.drop(own);
      if (this.inflight === own) this.inflight = null;
      this.failures = 0;
    }
    this.settleAcked();
    this.rebuild();
    if (message.origin !== this.deps.clientId) {
      this.deps.onRemote?.({ by: message.by, changed: applied.changed });
    }
  }

  /**
   * Which pending list a broadcast of our own is: the one in flight at its
   * base, or else one whose answer was lost (a failed POST the server applied).
   */
  private ownList(
    message: Extract<SheetRoomMessage, { type: "sheet.revision" }>,
  ): Pending | null {
    if (this.inflight && this.inflight.sentBase === message.base) return this.inflight;
    const sent = JSON.stringify(message.edits);
    return (
      this.pending.find(
        (item) => item.ackedAt === null && item !== this.inflight && JSON.stringify(item.edits) === sent,
      ) ?? null
    );
  }

  private pump(): void {
    if (this.closed || this.inflight || this.fetching || this.timer !== null) return;
    if (this.confirmedWorkbook.revision < this.behindUntil) return;
    if (this.pending.some((item) => item.ackedAt !== null)) return;
    const next = this.pending[0];
    if (!next) return;
    const base = this.confirmedWorkbook.revision;
    next.sentBase = base;
    this.inflight = next;
    void this.deps.post(base, next.edits).then(
      (outcome) => this.settle(next, outcome),
      () => this.settle(next, { kind: "failed" }),
    );
  }

  private settle(item: Pending, outcome: EditsOutcome): void {
    // Settled already by its broadcast, or dropped by a fetch.
    if (this.closed || this.inflight !== item) return;
    this.inflight = null;
    const base = item.sentBase;
    item.sentBase = null;
    switch (outcome.kind) {
      case "applied": {
        this.failures = 0;
        if (base !== null && this.confirmedWorkbook.revision === base && !this.fetching) {
          const applied = applyEdits(this.confirmedWorkbook, base, item.edits);
          if (!isRefusal(applied) && applied.revision === outcome.revision) {
            this.confirmedWorkbook = applied.workbook;
            this.drop(item);
            this.rebuild();
            break;
          }
        }
        // Landed, but this page cannot place it yet: keep it on top until a fetch has it.
        item.ackedAt = outcome.revision;
        this.refetch();
        break;
      }
      case "stale":
        this.behindUntil = outcome.revision;
        if (this.confirmedWorkbook.revision < outcome.revision) {
          const set = this.deps.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms));
          if (this.staleTimer !== null) this.clear(this.staleTimer);
          this.staleTimer = set(() => {
            this.staleTimer = null;
            if (this.confirmedWorkbook.revision < this.behindUntil) this.refetch();
          }, STALE_WAIT_MS);
        }
        break;
      case "refused":
        this.drop(item);
        this.rebuild();
        if (outcome.refusal.refusal !== "nothingToChange") this.deps.onRefused?.(outcome.refusal);
        break;
      case "failed": {
        const delay = RETRY_MS[Math.min(this.failures, RETRY_MS.length - 1)] as number;
        this.failures += 1;
        this.wait(delay, () => undefined);
        break;
      }
      case "gone":
        this.closed = true;
        this.deps.onGone?.();
        return;
    }
    if (this.refetchWanted && !this.fetching) this.refetch();
    this.pump();
  }

  private wait(ms: number, then: () => void): void {
    const set = this.deps.setTimer ?? ((run: () => void, delay: number) => setTimeout(run, delay));
    this.timer = set(() => {
      this.timer = null;
      then();
      this.pump();
    }, ms);
  }

  private refetch(): void {
    if (this.closed) return;
    if (this.fetching || this.inflight) {
      // Once the list in flight is answered: a fetch now could miss it or count it twice.
      this.refetchWanted = true;
      return;
    }
    this.fetching = true;
    this.refetchWanted = false;
    this.deps.fetch().then(
      (workbook) => {
        if (this.closed) return;
        this.fetching = false;
        this.confirmedWorkbook = workbook;
        const replay = this.buffered.filter((message) => message.revision > workbook.revision);
        this.buffered = [];
        this.settleAcked();
        for (const message of replay) this.land(message);
        this.rebuild();
        if (this.refetchWanted) this.refetch();
        this.pump();
      },
      () => {
        if (this.closed) return;
        this.fetching = false;
        this.wait(RETRY_MS[1] as number, () => this.refetch());
      },
    );
  }

  /** Drops lists the confirmed workbook already holds. */
  private settleAcked(): void {
    const revision = this.confirmedWorkbook.revision;
    for (const item of [...this.pending]) {
      if (item.ackedAt !== null && item.ackedAt <= revision) this.drop(item);
    }
    if (this.behindUntil <= revision) {
      this.behindUntil = -1;
      if (this.staleTimer !== null) {
        this.clear(this.staleTimer);
        this.staleTimer = null;
      }
    }
  }

  private clear(timer: unknown): void {
    if (this.deps.clearTimer) this.deps.clearTimer(timer);
    else clearTimeout(timer as ReturnType<typeof setTimeout>);
  }

  private drop(item: Pending): void {
    const at = this.pending.indexOf(item);
    if (at >= 0) this.pending.splice(at, 1);
  }

  /** The view again: confirmed, then each pending list. One that no longer applies is dropped. */
  private rebuild(): void {
    let workbook = this.confirmedWorkbook;
    for (const item of [...this.pending]) {
      const applied = applyEdits(workbook, workbook.revision, item.edits);
      if (isRefusal(applied)) {
        // Someone else's change made it impossible (its tab was deleted, say).
        if (item !== this.inflight && item.ackedAt === null) {
          this.drop(item);
          if (applied.refusal !== "nothingToChange") this.deps.onRefused?.(applied);
        }
        continue;
      }
      workbook = applied.workbook;
    }
    this.viewWorkbook = workbook;
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
