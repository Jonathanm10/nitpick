import { spawn } from "node:child_process"

/** One out-of-process invocation: an absolute executable path plus arguments, never a shell string. */
export interface SubprocessCommand {
  readonly executablePath: string
  readonly arguments: ReadonlyArray<string>
}

/** What a finished subprocess left behind. */
export interface SubprocessResult {
  readonly exitCode: number
  readonly standardOutput: Buffer
  readonly standardError: Buffer
}

/**
 * The subprocess effects seam. Implementations run the command to completion;
 * a non-zero exit is reported in the result, not thrown. Throwing is reserved
 * for failure to run the command at all (missing executable, spawn failure).
 */
export interface SubprocessRunner {
  run(command: SubprocessCommand): Promise<SubprocessResult>
}

/** A subprocess exited non-zero where the server required success. */
export class SubprocessFailure extends Error {
  readonly command: SubprocessCommand
  readonly exitCode: number
  readonly standardError: string

  constructor(
    command: SubprocessCommand,
    exitCode: number,
    standardError: string
  ) {
    const commandLine = [command.executablePath, ...command.arguments].join(" ")
    const trimmed = standardError.trim()
    super(
      `Command failed (exit ${exitCode}): ${commandLine}` +
        (trimmed === "" ? "" : `\n${trimmed}`)
    )
    this.name = "SubprocessFailure"
    this.command = command
    this.exitCode = exitCode
    this.standardError = standardError
  }
}

/** Live runner: spawns the executable directly, with no shell in between. */
export const nodeSubprocessRunner: SubprocessRunner = {
  run(command) {
    return new Promise((resolve, reject) => {
      const child = spawn(command.executablePath, command.arguments, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      })
      const standardOutput: Buffer[] = []
      const standardError: Buffer[] = []
      child.stdout.on("data", (chunk: Buffer) => standardOutput.push(chunk))
      child.stderr.on("data", (chunk: Buffer) => standardError.push(chunk))
      child.on("error", reject)
      child.on("close", (code) => {
        resolve({
          // A process killed by a signal has no exit code; count it as a failure.
          exitCode: code ?? 1,
          standardOutput: Buffer.concat(standardOutput),
          standardError: Buffer.concat(standardError),
        })
      })
    })
  },
}
