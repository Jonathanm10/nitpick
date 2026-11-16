// Inspect on iOS (ADR-0015): the library the Device Host builds from
// server/inspector/Inspector.m, what a launch passes it, and how the server
// asks a running Build for its layout. Only the server talks to the library.
import { createHash, randomBytes } from "node:crypto"
import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { SubprocessCommand, SubprocessRunner } from "../subprocess.ts"
import { runRequiringSuccess } from "./simctl.ts"

export const inspectorSource = fileURLToPath(
  new URL("../../inspector/Inspector.m", import.meta.url)
)

const libraryName = "libnitpickinspect.dylib"

/**
 * Compiles the library for the iOS simulator. Both architectures, so a Build
 * made for an Intel simulator still loads it; iOS 15, for TextKit 2's text
 * storage it reads.
 */
export function inspectorBuildCommand(
  source: string,
  output: string
): SubprocessCommand {
  return {
    executablePath: "/usr/bin/xcrun",
    arguments: [
      "--sdk",
      "iphonesimulator",
      "clang",
      "-arch",
      "arm64",
      "-arch",
      "x86_64",
      "-mios-simulator-version-min=15.0",
      "-dynamiclib",
      "-fobjc-arc",
      "-O2",
      "-framework",
      "Foundation",
      "-framework",
      "UIKit",
      "-framework",
      "CoreGraphics",
      "-o",
      output,
      source,
    ],
  }
}

/** Whether this host can inspect iOS Builds, and with which library. */
export type InspectLibrary =
  | { readonly status: "built"; readonly path: string }
  | { readonly status: "unbuilt"; readonly reason: string }

/** Why the Device Host can't inspect, as the page shows it. */
export const inspectUnbuiltReason =
  "Inspect isn't available on the Device Host: Xcode couldn't build its library."

/**
 * The library for the current source, compiled once into `directory` under
 * a hash of the source and the command, and reused while both are the same.
 * Older builds go once a new one is in place. A failed compile is logged
 * for the host's operator and answers why Inspect is off.
 */
export async function buildInspectLibrary(
  runner: SubprocessRunner,
  directory: string,
  source = inspectorSource
): Promise<InspectLibrary> {
  try {
    const hash = createHash("sha256")
      .update(await readFile(source))
      .update(JSON.stringify(inspectorBuildCommand("", "").arguments))
      .digest("hex")
      .slice(0, 16)
    const path = join(directory, hash, libraryName)
    if (
      await stat(path).then(
        (found) => found.isFile(),
        () => false
      )
    ) {
      return { status: "built", path }
    }
    await mkdir(join(directory, hash), { recursive: true })
    // Built aside and moved in, so a half-written library is never loaded.
    const building = `${path}.${process.pid}.building`
    await runRequiringSuccess(runner, inspectorBuildCommand(source, building))
    await rename(building, path)
    for (const older of await readdir(directory)) {
      if (older !== hash) {
        await rm(join(directory, older), { recursive: true, force: true })
      }
    }
    return { status: "built", path }
  } catch (error) {
    console.error(
      `Building the Inspect library failed: ${error instanceof Error ? error.message : String(error)}`
    )
    return { status: "unbuilt", reason: inspectUnbuiltReason }
  }
}

/** Where one launch of a Build answers Inspect, and the secret it asks for. */
export interface InspectEndpoint {
  readonly port: number
  readonly secret: string
}

export function newInspectSecret(): string {
  return randomBytes(32).toString("hex")
}

/**
 * What `simctl launch` passes to the Build so that it loads the library,
 * which then listens on the endpoint's loopback port for its secret.
 * simctl hands each SIMCTL_CHILD_ variable to the app without the prefix.
 */
export function inspectLaunchEnvironment(
  library: string,
  endpoint: InspectEndpoint
): Readonly<Record<string, string>> {
  return {
    SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: library,
    SIMCTL_CHILD_NITPICK_INSPECT_PORT: String(endpoint.port),
    SIMCTL_CHILD_NITPICK_INSPECT_SECRET: endpoint.secret,
  }
}

/** The Build didn't answer Inspect with a layout. */
export class InspectFailed extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InspectFailed"
  }
}

/**
 * The first answer after a launch waits on SwiftUI's first debug pass,
 * which takes seconds on a large Build.
 */
const answerTimeout = 20_000

/** Far above a real screen's tree, which runs to a few megabytes. */
const maxAnswerBytes = 64 * 1024 * 1024

/** The Build's layout as the library answers it, parsed but not yet read. */
export async function fetchLayout(endpoint: InspectEndpoint): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(`http://127.0.0.1:${endpoint.port}/layout`, {
      headers: { authorization: `Bearer ${endpoint.secret}` },
      signal: AbortSignal.timeout(answerTimeout),
    })
  } catch (error) {
    throw new InspectFailed(
      error instanceof Error && error.name === "TimeoutError"
        ? "The Build took too long to answer Inspect. Try again once it settles."
        : "The Build isn't answering Inspect: it may have quit or still be starting. Try again, or resume review to relaunch it."
    )
  }
  const length = Number(response.headers.get("content-length"))
  if (!response.ok || length > maxAnswerBytes) {
    await response.body?.cancel()
    throw new InspectFailed(
      `The Build couldn't read its layout for Inspect (status ${response.status}).`
    )
  }
  try {
    return JSON.parse(await response.text())
  } catch {
    throw new InspectFailed("The Build's layout for Inspect couldn't be read.")
  }
}
