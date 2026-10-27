// Ported from Sources/NitpickCore/TypingSave.swift. Times are milliseconds
// on any monotonic clock, such as the browser's performance.now().
import type { ShellActivity } from "./shellActivity.ts"

/**
 * When typed text is saved. A save writes the whole Finding field, so a
 * keystroke defers it until typing pauses for `quietPeriod`, but never past
 * `maximumDelay` after the first unsaved keystroke: steady typing still
 * saves, and a crash loses at most `maximumDelay` of it. A failed save stays
 * pending and retries within `maximumDelay`, so a transient failure never
 * drops what the Reviewer typed.
 *
 * A value, like the Swift struct: each step returns the next TypingSave with
 * the time the save is due.
 */
export class TypingSave {
  static readonly quietPeriod = 500
  static readonly maximumDelay = 2000

  readonly #unsavedSince: number | undefined

  constructor(unsavedSince?: number) {
    this.#unsavedSince = unsavedSince
  }

  get isPending(): boolean {
    return this.#unsavedSince !== undefined
  }

  /**
   * Whether a flush point writes now. Never while filing: the run saves its
   * own copy of the session after every step, and a page write could
   * replace a newer step with an older session.
   */
  flushes(activity: Pick<ShellActivity, "isFiling">): boolean {
    return this.isPending && !activity.isFiling
  }

  /** Records a keystroke at `now`, and when the save is due. */
  keystroke(now: number): { readonly save: TypingSave; readonly due: number } {
    const first = this.#unsavedSince ?? now
    return {
      save: new TypingSave(first),
      due: Math.min(
        now + TypingSave.quietPeriod,
        first + TypingSave.maximumDelay
      ),
    }
  }

  saved(): TypingSave {
    return new TypingSave()
  }

  /** Records a save that failed at `now`, and when to retry. */
  failed(now: number): { readonly save: TypingSave; readonly due: number } {
    return { save: new TypingSave(now), due: now + TypingSave.maximumDelay }
  }
}
