// The Device Host's health check, ported from checkSetup in
// Sources/NitpickCore/Setup.swift. Reviewers can't fix the host, so a
// problem carries only the reason the page shows; the fix steps live in the
// ops runbook.
import { SubprocessFailure, type SubprocessRunner } from "../subprocess.ts"
import type { HostHealth, HostProblem, SimulatorDevice } from "./DeviceHost.ts"
import {
  listSimulatorDevices,
  MalformedDeviceList,
  runRequiringSuccess,
} from "./simctl.ts"

/** The page's "Device Host not ready" reason. Raw tool errors never reach it. */
export function hostProblemReason(problem: HostProblem): string {
  switch (problem.kind) {
    case "xcodeNotInstalled":
      return "Xcode isn't installed on the Device Host, and nitpick needs its iOS simulator to run your Build."
    case "commandLineToolsOnly":
      return "The Device Host has only the Command Line Tools selected, and the iOS simulator ships with full Xcode."
    case "xcodeSetupIncomplete":
      return "Xcode is installed on the Device Host, but its simulator tools aren't working yet."
    case "missingIOSRuntime":
      return "No iOS simulator is ready to use on the Device Host: the iOS platform isn't installed."
  }
}

/**
 * Probes the host's review prerequisites, cheapest first: an active
 * developer directory that is a full Xcode, working simulator tools, and at
 * least one iOS simulator device with an installed runtime. Run on page load,
 * after every upload, at session start and by "Check again", so a missing
 * piece shows as a reason before any boot is attempted.
 */
export async function checkHostHealth(
  runner: SubprocessRunner
): Promise<HostHealth> {
  let developerDirectory: string
  try {
    developerDirectory = await activeDeveloperDirectory(runner)
  } catch (error) {
    if (error instanceof SubprocessFailure) {
      return { status: "notReady", problem: { kind: "xcodeNotInstalled" } }
    }
    throw error
  }
  // A full Xcode's developer directory lives inside the app bundle
  // (…/Xcode.app/Contents/Developer); the Command Line Tools' does not.
  if (!developerDirectory.endsWith(".app/Contents/Developer")) {
    return {
      status: "notReady",
      problem: { kind: "commandLineToolsOnly", developerDirectory },
    }
  }
  // From here on the tools themselves are the suspect: any simctl failure is
  // a host problem, not a raw tool error on the page.
  let devices: SimulatorDevice[]
  try {
    devices = await listSimulatorDevices(runner)
  } catch (error) {
    if (
      error instanceof SubprocessFailure ||
      error instanceof MalformedDeviceList
    ) {
      return { status: "notReady", problem: { kind: "xcodeSetupIncomplete" } }
    }
    throw error
  }
  if (!devices.some((device) => device.isRuntimeAvailable)) {
    return { status: "notReady", problem: { kind: "missingIOSRuntime" } }
  }
  return { status: "ready", devices }
}

/**
 * `xcode-select -p`, trimmed. A non-zero exit or empty output is a
 * SubprocessFailure, which the health check reads as no Xcode.
 */
async function activeDeveloperDirectory(
  runner: SubprocessRunner
): Promise<string> {
  const command = {
    executablePath: "/usr/bin/xcode-select",
    arguments: ["-p"],
  }
  const result = await runRequiringSuccess(runner, command)
  let path = result.standardOutput.toString("utf8").trim()
  // Swift read it as a directory URL, whose path has no trailing slash.
  while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1)
  // xcode-select can exit 0 with empty stdout; treat that like no Xcode.
  if (path === "") {
    throw new SubprocessFailure(
      command,
      result.exitCode,
      result.standardError.toString("utf8")
    )
  }
  return path
}
