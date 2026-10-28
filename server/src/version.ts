// The server's version for a Feedback's Environment: the package version and
// the commit it runs from, such as "0.0.0 (3b9ef47)". The web app bakes the
// same pair in at build time, so the two differ when a tab predates a deploy.
import { readFile } from "node:fs/promises"
import type { SubprocessRunner } from "./subprocess.ts"

export async function readServerVersion(
  runner: SubprocessRunner,
  packageJSON = new URL("../package.json", import.meta.url)
): Promise<string> {
  const { version } = JSON.parse(await readFile(packageJSON, "utf8")) as {
    version: string
  }
  const commit = await runner
    .run({
      executablePath: "/usr/bin/git",
      arguments: [
        "-C",
        new URL(".", packageJSON).pathname,
        "rev-parse",
        "--short",
        "HEAD",
      ],
    })
    .then((result) =>
      result.exitCode === 0 ? result.standardOutput.toString("utf8").trim() : ""
    )
    .catch(() => "")
  return commit === "" ? version : `${version} (${commit})`
}
