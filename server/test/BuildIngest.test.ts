// Ports Tests/NitpickCoreTests/BuildIngestTests.swift and
// ZipIngestTests.swift. A browser uploads files, so a bare .app is no longer
// ingested: the Info.plist cases read the bundle directly, and the upload
// path is the zip's. Swift's "a nonexistent path is reported" has no
// counterpart, since an upload has no path.
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { beforeEach, describe, expect, test, vi } from "vitest"
import {
  BuildIngestError,
  buildName,
  readAppBundle,
  readBuildFromArchive,
  zipArchiveName,
} from "../src/buildIngestion.ts"
import { SubprocessFailure } from "../src/subprocess.ts"
import {
  simulatorInfoPlist,
  temporaryDirectory,
  writeAppBundle,
} from "./BuildFixtures.ts"
import { FakeSubprocessRunner } from "./FakeSubprocessRunner.ts"

const reviewMe = {
  bundleID: "ch.liip.reviewme",
  version: "2.1.0",
  buildNumber: "421",
}

function ingestError(failure: BuildIngestError["failure"]): BuildIngestError {
  return new BuildIngestError(failure)
}

describe("Build ingestion", () => {
  let temp: string

  beforeEach(() => {
    temp = temporaryDirectory()
  })

  test("a simulator .app yields its identity without any subprocess", async () => {
    const app = writeAppBundle(temp, "ReviewMe.app", simulatorInfoPlist())

    const build = await readAppBundle(app)

    expect(build.identity).toEqual(reviewMe)
    expect(build.appBundleURL).toBe(`${pathToFileURL(app).href}/`)
    expect(buildName(build)).toBe("ReviewMe")
  })

  test("a device Build is rejected as not a simulator Build", async () => {
    const app = writeAppBundle(temp, "ReviewMe.app", {
      ...simulatorInfoPlist(),
      CFBundleSupportedPlatforms: ["iPhoneOS"],
    })

    await expect(readAppBundle(app)).rejects.toThrow(
      ingestError({
        kind: "notASimulatorBuild",
        bundleName: "ReviewMe.app",
        platforms: ["iPhoneOS"],
      })
    )
  })

  test("a bundle that declares no platform is rejected", async () => {
    const plist = simulatorInfoPlist()
    delete plist.CFBundleSupportedPlatforms
    const app = writeAppBundle(temp, "ReviewMe.app", plist)

    await expect(readAppBundle(app)).rejects.toThrow(
      "“ReviewMe.app” is built for an unknown platform, not the iOS simulator. Ask for a simulator Build from CI."
    )
  })

  test("a file that is neither .app nor .zip is rejected", () => {
    expect(() => zipArchiveName("notes.txt")).toThrow(
      "“notes.txt” is not a Build. Drop or choose a zip containing a simulator .app."
    )
  })

  test("an .app without Info.plist is rejected", async () => {
    const app = join(temp, "Broken.app")
    mkdirSync(app)

    await expect(readAppBundle(app)).rejects.toThrow(
      "“Broken.app” has no Info.plist, so its identity can't be read. Is it a complete .app bundle?"
    )
  })

  test("an unparseable Info.plist is rejected", async () => {
    // The XML parser reports what it can't read on the console.
    vi.spyOn(console, "error").mockImplementation(() => {})
    const app = join(temp, "Broken.app")
    mkdirSync(app)
    writeFileSync(join(app, "Info.plist"), "not a plist")

    await expect(readAppBundle(app)).rejects.toThrow(
      "The Info.plist in “Broken.app” can't be read."
    )
  })

  test("an Info.plist without identity keys names what is missing", async () => {
    const app = writeAppBundle(temp, "Anon.app", {
      CFBundleIdentifier: "ch.liip.anon",
      CFBundleSupportedPlatforms: ["iPhoneSimulator"],
    })

    await expect(readAppBundle(app)).rejects.toThrow(
      "The Info.plist in “Anon.app” is missing CFBundleShortVersionString, CFBundleVersion."
    )
  })
})

// Not in the Swift suite: where the web app's intake differs from the drop.
describe("Build ingestion, port checks", () => {
  test("a binary Info.plist, as CI Builds carry, is read like an XML one", async () => {
    const app = writeAppBundle(
      temporaryDirectory(),
      "ReviewMe.app",
      simulatorInfoPlist(),
      { binary: true }
    )

    expect((await readAppBundle(app)).identity).toEqual(reviewMe)
  })

  test("a bare .app is refused: a browser uploads files, not bundles", () => {
    expect(() => zipArchiveName("ReviewMe.app")).toThrow(
      ingestError({ kind: "unsupportedFileType", fileName: "ReviewMe.app" })
    )
  })

  test("the zip check ignores case, as Swift lowercased the extension", () => {
    expect(zipArchiveName("Build.ZIP")).toBe("Build.ZIP")
  })

  test("a non-string identity value counts as missing", async () => {
    const app = writeAppBundle(temporaryDirectory(), "ReviewMe.app", {
      ...simulatorInfoPlist(),
      CFBundleVersion: 421,
    })

    await expect(readAppBundle(app)).rejects.toThrow(
      ingestError({
        kind: "missingIdentityKeys",
        bundleName: "ReviewMe.app",
        keys: ["CFBundleVersion"],
      })
    )
  })
})

describe("Zipped Build ingestion", () => {
  let temp: string
  let destination: string
  let runner: FakeSubprocessRunner
  let zipPath: string

  beforeEach(() => {
    temp = temporaryDirectory()
    destination = join(temp, "builds", "build-1")
    mkdirSync(destination, { recursive: true })
    runner = new FakeSubprocessRunner()
    zipPath = join(temp, "uploads", "build-1.zip")
  })

  function ingest(name = "build.zip") {
    return readBuildFromArchive(
      runner,
      { path: zipPath, name: zipArchiveName(name) },
      destination
    )
  }

  test("a zipped Build is extracted via tar and yields its identity", async () => {
    runner.enqueue({
      exitCode: 0,
      effect: () => {
        writeAppBundle(destination, "ReviewMe.app", simulatorInfoPlist())
      },
    })

    const build = await ingest()

    expect(runner.executedCommands).toEqual([
      {
        executablePath: "/usr/bin/tar",
        arguments: ["-x", "-f", zipPath, "-C", destination],
      },
    ])
    expect(build.identity).toEqual(reviewMe)
    expect(build.appBundleURL).toBe(
      `${pathToFileURL(join(destination, "ReviewMe.app")).href}/`
    )
  })

  test("an .app nested in a folder inside the archive is found", async () => {
    runner.enqueue({
      exitCode: 0,
      effect: () => {
        writeAppBundle(
          join(destination, "Products", "Applications"),
          "ReviewMe.app",
          simulatorInfoPlist()
        )
      },
    })

    const build = await ingest()

    expect(build.identity.bundleID).toBe("ch.liip.reviewme")
    expect(build.appBundleURL).toMatch(
      /\/Products\/Applications\/ReviewMe\.app\/$/
    )
  })

  test("a zip without any .app inside is rejected", async () => {
    runner.enqueue({ exitCode: 0 })

    await expect(ingest()).rejects.toThrow(
      "“build.zip” contains no .app bundle."
    )
  })

  test("an extraction failure surfaces the command and its stderr", async () => {
    runner.enqueue({ exitCode: 1, standardError: "tar: Path contains '..'" })

    await expect(ingest()).rejects.toThrow(SubprocessFailure)
  })

  test("a hidden-file zip extracts into its own contained directory", async () => {
    // A pre-existing extraction from an earlier ingest must survive.
    const earlier = join(temp, "builds", "earlier")
    mkdirSync(earlier, { recursive: true })
    runner.enqueue({
      exitCode: 0,
      effect: () => {
        writeAppBundle(destination, "ReviewMe.app", simulatorInfoPlist())
      },
    })

    const build = await ingest(".hidden.zip")

    expect(build.appBundleURL).toBe(
      `${pathToFileURL(join(destination, "ReviewMe.app")).href}/`
    )
    expect(existsSync(earlier)).toBe(true)
  })

  test("a leading-dot zip name is rejected, never extracted", () => {
    // Foundation parses "..zip" as extensionless, so it is an unsupported
    // file type long before any extraction.
    expect(() => zipArchiveName("..zip")).toThrow(
      ingestError({ kind: "unsupportedFileType", fileName: "..zip" })
    )
    expect(runner.executedCommands).toEqual([])
  })

  test("a symlinked .app pointing outside the extraction root is not ingested", async () => {
    // bsdtar refuses writing through symlinks but extracts bare symlink
    // entries, so a crafted archive can deliver `ReviewMe.app` as a symlink
    // to a directory outside the extraction root.
    const outside = writeAppBundle(
      join(temp, "outside"),
      "Outside.app",
      simulatorInfoPlist()
    )
    runner.enqueue({
      exitCode: 0,
      effect: () => symlinkSync(outside, join(destination, "ReviewMe.app")),
    })

    await expect(ingest()).rejects.toThrow(
      ingestError({ kind: "noAppBundleInArchive", archiveName: "build.zip" })
    )
  })
})
