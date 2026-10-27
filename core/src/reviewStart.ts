// The Start review gate, ported from ReviewStart in
// Sources/NitpickCore/ReviewRun.swift. Start or Resume review exists only
// when every fact allows it; the Build is part of the decision because home
// shows the button before a Build exists.
import type { YouTrackProject } from "./youtrack.ts"

export interface ReviewStartFacts<Build> {
  readonly build: Build | undefined
  readonly isReviewing: boolean
  readonly holdsFilingResult: boolean
  readonly device: { readonly isRuntimeAvailable: boolean } | undefined
  readonly session: { readonly project: YouTrackProject } | undefined
  readonly selectedProject: YouTrackProject | undefined
  readonly isBusy: boolean
}

export interface ReviewStart<Build> {
  readonly build: Build
  /**
   * The open session's pinned project, else the picker's choice: filing
   * never re-asks.
   */
  readonly project: YouTrackProject
}

/** The start the facts allow, or undefined when any one forbids it. */
export function reviewStart<Build>(
  facts: ReviewStartFacts<Build>
): ReviewStart<Build> | undefined {
  const project = facts.session?.project ?? facts.selectedProject
  if (
    facts.build === undefined ||
    facts.isReviewing ||
    facts.holdsFilingResult ||
    facts.device?.isRuntimeAvailable !== true ||
    project === undefined ||
    facts.isBusy
  ) {
    return undefined
  }
  return { build: facts.build, project }
}
