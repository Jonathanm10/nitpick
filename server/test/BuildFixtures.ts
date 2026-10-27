// Ports the Build half of Tests/NitpickCoreTests/Support/Fixtures.swift.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { build, buildBinary, type PlistValue } from "plist"
import { onTestFinished } from "vitest"

type InfoPlist = { [key: string]: PlistValue }

export function simulatorInfoPlist({
  bundleID = "ch.liip.reviewme",
  version = "2.1.0",
  buildNumber = "421",
} = {}): InfoPlist {
  return {
    CFBundleIdentifier: bundleID,
    CFBundleShortVersionString: version,
    CFBundleVersion: buildNumber,
    CFBundleSupportedPlatforms: ["iPhoneSimulator"],
  }
}

/** A .app bundle holding only its Info.plist, XML unless `binary`. */
export function writeAppBundle(
  directory: string,
  name: string,
  infoPlist: InfoPlist,
  { binary = false } = {}
): string {
  const bundle = join(directory, name)
  mkdirSync(bundle, { recursive: true })
  writeFileSync(
    join(bundle, "Info.plist"),
    binary ? buildBinary(infoPlist) : build(infoPlist)
  )
  return bundle
}

/** A fresh directory, deleted when the test ends. */
export function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "nitpick-server-"))
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}
