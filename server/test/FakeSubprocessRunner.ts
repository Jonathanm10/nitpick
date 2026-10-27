import type {
  SubprocessCommand,
  SubprocessResult,
  SubprocessRunner,
} from "../src/subprocess.ts"

/**
 * Scripted stand-in for the subprocess seam, after
 * Tests/NitpickCoreTests/Support/FakeSubprocessRunner.swift. Responses are
 * consumed in FIFO order and every executed command is recorded.
 */
export class FakeSubprocessRunner implements SubprocessRunner {
  readonly executedCommands: SubprocessCommand[] = []
  private readonly results: SubprocessResult[] = []

  enqueue(result: {
    exitCode: number
    standardOutput?: string
    standardError?: string
  }): void {
    this.results.push({
      exitCode: result.exitCode,
      standardOutput: Buffer.from(result.standardOutput ?? ""),
      standardError: Buffer.from(result.standardError ?? ""),
    })
  }

  async run(command: SubprocessCommand): Promise<SubprocessResult> {
    this.executedCommands.push(command)
    const result = this.results.shift()
    if (result === undefined) {
      throw new Error(`No stubbed response for ${command.executablePath}`)
    }
    return result
  }
}
