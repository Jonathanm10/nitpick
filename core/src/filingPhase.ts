// The File all button's state, ported from Sources/NitpickCore/FilingPhase.swift:
// the Tray's marks plus the run facts only the page knows.
import { filedIssueOf, type ReviewSession } from "./reviewSession.ts"

export type FilingPhase =
  | { readonly phase: "idle"; readonly unfiled: number }
  | {
      readonly phase: "filing"
      readonly completed: number
      readonly total: number
    }
  | { readonly phase: "remaining"; readonly unfiled: number }
  | { readonly phase: "allFiled"; readonly count: number }

/**
 * Derives the phase from the Tray's marks and the run. Core can count
 * acknowledged marks, but not whether a File all is still running or whether
 * the label should say "remaining" after a failure, so those come in.
 */
export function filingPhase(
  session: ReviewSession,
  run: { readonly isRunning: boolean; readonly stoppedByFailure: boolean }
): FilingPhase {
  const total = session.tray.length
  const filed = session.tray.filter(
    (item) => filedIssueOf(item) !== undefined
  ).length
  // An empty Tray has nothing unfiled, but "done" is a payoff, not a vacuous
  // truth: a session with nothing captured is idle.
  if (total === 0) return { phase: "idle", unfiled: 0 }
  if (run.isRunning) return { phase: "filing", completed: filed, total }
  if (filed === total) return { phase: "allFiled", count: total }
  if (run.stoppedByFailure)
    return { phase: "remaining", unfiled: total - filed }
  return { phase: "idle", unfiled: total - filed }
}
