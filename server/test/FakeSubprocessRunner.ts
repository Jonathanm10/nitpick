import type {
  SubprocessCommand,
  SubprocessResult,
  SubprocessRunner,
} from "../src/subprocess.ts"

interface Stub {
  readonly result: SubprocessResult
  readonly effect?: (command: SubprocessCommand) => void | Promise<void>
}

/**
 * Scripted stand-in for the subprocess seam, after
 * Tests/NitpickCoreTests/Support/FakeSubprocessRunner.swift. Responses are
 * consumed in FIFO order and every executed command is recorded. A stub's
 * `effect` runs before its result returns, standing in for what the real
 * command leaves on disk.
 */
export class FakeSubprocessRunner implements SubprocessRunner {
  readonly executedCommands: SubprocessCommand[] = []
  private readonly stubs: Stub[] = []

  enqueue(result: {
    exitCode: number
    standardOutput?: string
    standardError?: string
    effect?: Stub["effect"]
  }): void {
    this.stubs.push({
      result: {
        exitCode: result.exitCode,
        standardOutput: Buffer.from(result.standardOutput ?? ""),
        standardError: Buffer.from(result.standardError ?? ""),
      },
      effect: result.effect,
    })
  }

  async run(command: SubprocessCommand): Promise<SubprocessResult> {
    this.executedCommands.push(command)
    const stub = this.stubs.shift()
    if (stub === undefined) {
      throw new Error(`No stubbed response for ${command.executablePath}`)
    }
    await stub.effect?.(command)
    return stub.result
  }
}
