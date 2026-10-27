import { describe, expect, test } from "vitest"
import { nodeSubprocessRunner } from "../src/subprocess.ts"

// Node itself is the executable, so these run on any CI machine.
const printArguments =
  "process.stdout.write(JSON.stringify(process.argv.slice(1)))"

describe("Live subprocess runner", () => {
  test("arguments reach the executable verbatim, with no shell in between", async () => {
    const hostile = ["$HOME", "a b", "; echo injected", "`id`", "*"]

    const result = await nodeSubprocessRunner.run({
      executablePath: process.execPath,
      arguments: ["-e", printArguments, "--", ...hostile],
    })

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.standardOutput.toString("utf8"))).toEqual(hostile)
  })

  test("a non-zero exit is reported in the result, with its stderr", async () => {
    const result = await nodeSubprocessRunner.run({
      executablePath: process.execPath,
      arguments: ["-e", "process.stderr.write('boom'); process.exit(3)"],
    })

    expect(result.exitCode).toBe(3)
    expect(result.standardError.toString("utf8")).toBe("boom")
  })

  test("a missing executable rejects", async () => {
    await expect(
      nodeSubprocessRunner.run({
        executablePath: "/nonexistent/xcrun",
        arguments: [],
      })
    ).rejects.toThrow(/ENOENT/)
  })
})
