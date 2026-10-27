// What is running for one Reviewer, ported from
// Sources/NitpickCore/ShellActivity.swift. One value, so "busy" and "filing"
// can never disagree. The server holds one per Reviewer and refuses a second
// run while one is going.

/** Filing is the only work a reader tells apart: File all shows its progress. */
export type ShellWork = "filing" | "other"

/** A run was refused because another one is going. */
export class ShellBusy extends Error {
  constructor() {
    super(
      "Nitpick was busy, so that didn’t run. Try again when the current step finishes."
    )
    this.name = "ShellBusy"
  }
}

export class ShellActivity {
  readonly running: ShellWork | undefined
  /**
   * Unrelated work leaves it alone, so the Tray row that shows it keeps
   * showing it.
   */
  readonly filingFailure: string | undefined

  constructor(running?: ShellWork, filingFailure?: string) {
    this.running = running
    this.filingFailure = filingFailure
  }

  get isBusy(): boolean {
    return this.running !== undefined
  }

  get isFiling(): boolean {
    return this.running === "filing"
  }

  /**
   * One run at a time, so no run can end another's busy state, and a Build
   * ingest can never end the session a File all run is still writing back.
   * A refusal throws ShellBusy so the page can show it: a confirmed action
   * never does nothing silently.
   */
  begin(work: ShellWork): ShellActivity {
    if (this.running !== undefined) throw new ShellBusy()
    return new ShellActivity(
      work,
      work === "filing" ? undefined : this.filingFailure
    )
  }

  end(): ShellActivity {
    return new ShellActivity(undefined, this.filingFailure)
  }

  recordFilingFailure(message: string): ShellActivity {
    return new ShellActivity(this.running, message)
  }

  forgetFilingFailure(): ShellActivity {
    return new ShellActivity(this.running, undefined)
  }
}
