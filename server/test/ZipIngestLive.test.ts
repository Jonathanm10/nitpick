// Not a port: the ingest path with no fakes. A zip made the way CI makes
// one (ditto), extracted by the host's own bsdtar, with a binary Info.plist.
// macOS only, like the Device Host.
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { readBuildFromArchive } from "../src/buildIngestion.ts"
import { nodeSubprocessRunner } from "../src/subprocess.ts"
import {
  simulatorInfoPlist,
  temporaryDirectory,
  writeAppBundle,
} from "./BuildFixtures.ts"

describe.runIf(process.platform === "darwin")(
  "Zipped Build ingestion, live",
  () => {
    test("a ditto zip of a simulator .app extracts with tar and yields its identity", async () => {
      const temp = temporaryDirectory()
      const app = writeAppBundle(
        join(temp, "Products"),
        "Review Me.app",
        simulatorInfoPlist(),
        { binary: true }
      )
      const zip = join(temp, "Review Me.zip")
      const zipped = await nodeSubprocessRunner.run({
        executablePath: "/usr/bin/ditto",
        arguments: ["-c", "-k", "--keepParent", app, zip],
      })
      expect(zipped.exitCode).toBe(0)
      const destination = join(temp, "builds", "b1")
      mkdirSync(destination, { recursive: true })

      const build = await readBuildFromArchive(
        nodeSubprocessRunner,
        { path: zip, name: "Review Me.zip" },
        destination
      )

      expect(build.identity).toEqual({
        bundleID: "ch.liip.reviewme",
        version: "2.1.0",
        buildNumber: "421",
      })
      expect(existsSync(join(destination, "Review Me.app", "Info.plist"))).toBe(
        true
      )
    })
  }
)
