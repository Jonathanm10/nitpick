// Ports Tests/NitpickCoreTests/ReviewStartTests.swift.
import { describe, expect, test } from "vitest"
import type { ReviewSession } from "../src/reviewSession.ts"
import { reviewStart } from "../src/reviewStart.ts"
import type { YouTrackProject } from "../src/youtrack.ts"
import { session as restored } from "./fixtures.ts"

const build = restored.build
const picked: YouTrackProject = {
  id: "0-77",
  shortName: "JW",
  name: "Juniper Weather",
}
const device = { isRuntimeAvailable: true }

const brokenFacts = [
  "noBuild",
  "buildAlreadyRunning",
  "filingResultHeld",
  "noDevice",
  "runtimeUnavailable",
  "noProject",
  "workRunning",
] as const

type BrokenFact = (typeof brokenFacts)[number]

function start(fact?: BrokenFact, session?: ReviewSession) {
  return reviewStart({
    build: fact === "noBuild" ? undefined : build,
    isReviewing: fact === "buildAlreadyRunning",
    holdsFilingResult: fact === "filingResultHeld",
    device:
      fact === "noDevice"
        ? undefined
        : fact === "runtimeUnavailable"
          ? { isRuntimeAvailable: false }
          : device,
    session,
    selectedProject: fact === "noProject" ? undefined : picked,
    isBusy: fact === "workRunning",
  })
}

describe("Start review gate", () => {
  test("a loaded Build, an available device, and a picked project allow a start", () => {
    expect(start()).toEqual({ build, project: picked })
  })

  test("a restored session resumes under its pinned project, whatever the picker shows", () => {
    const resume = start("noProject", restored)
    const resumeWithOtherPick = start(undefined, restored)

    expect(resume?.project).toEqual(restored.project)
    expect(resumeWithOtherPick?.project).toEqual(restored.project)
  })

  test.each(brokenFacts)(
    "any one forbidding fact refuses the start: %s",
    (fact) => {
      expect(start(fact)).toBeUndefined()
    }
  )
})
