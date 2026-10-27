// The Swift suite's shared values: IssueFilingTests.session and .finding.
import { referenceDate } from "../src/date.ts"
import {
  newFinding,
  newReviewSession,
  type FilingProgress,
  type Finding,
  type ReviewSession,
} from "../src/review-session.ts"
import type { FiledIssue } from "../src/youtrack.ts"

export const session: ReviewSession = newReviewSession({
  build: {
    identity: {
      bundleID: "ch.liip.reviewme",
      version: "2.1.0",
      buildNumber: "421",
    },
    appBundleURL: "file:///tmp/ReviewMe.app/",
  },
  project: { id: "0-12", shortName: "RM", name: "Review Me" },
  startedAt: referenceDate(new Date("2026-07-04T09:15:32Z")),
})

export function finding({
  summary = "Button color is off",
  description = "The primary button is #FF0000, the design says #E64545.",
} = {}): Finding {
  return newFinding({
    summary,
    description,
    deviceContext: {
      deviceModel: "iPhone 17 Pro",
      osName: "iOS 26.4",
      accessibilitySettings: [],
    },
  })
}

export function filedIssue(idReadable: string): FiledIssue {
  return {
    idReadable,
    url: `https://youtrack.example.com/yt/issue/${idReadable}`,
  }
}

/**
 * Advances an item's filing the way the ladder records each acknowledged
 * step. The ladder itself is issue 05's, so the cases that ran it in Swift
 * set its marks directly.
 */
export function withFilingProgress(
  session: ReviewSession,
  id: string,
  filingProgress: FilingProgress
): ReviewSession {
  return {
    ...session,
    tray: session.tray.map((item) =>
      item.id === id ? { ...item, filingProgress } : item
    ),
  }
}

/** Every mark filing can leave on an item, short of and including filed. */
export const filingMarks: ReadonlyArray<FilingProgress> = [
  { state: "issueCreated", issueID: "3-505", idReadable: "RM-421" },
  { state: "attachmentsUploaded", issueID: "3-505", idReadable: "RM-421" },
  { state: "reviewTagged", issueID: "3-505", idReadable: "RM-421" },
  { state: "filed", issue: filedIssue("RM-421") },
]
