// The device stream's hub, after T3 Code's apps/server/src/device/LocalDeviceHost.ts
// (MIT): expo-device-hub at a pinned version, run as a supervised child so a
// crash in serve-sim's native code restarts the hub, not the server.
import { spawn, type ChildProcess } from "node:child_process"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { createServer } from "node:net"
import { delimiter, dirname, join } from "node:path"
import { createInterface } from "node:readline"
import type { AndroidSDK } from "./android.ts"

/** Where the running hub listens and the token it requires. Neither leaves the server. */
export interface HubEndpoint {
  readonly origin: string
  readonly token: string
}

/** What the proxy and the page's stream request need from the hub. */
export interface DeviceStream {
  /** The running hub, or undefined while it starts or restarts. */
  readonly endpoint: () => HubEndpoint | undefined
  /** Streams a booted simulator, waiting for the hub to start first. */
  readonly attach: (deviceUDID: string) => Promise<void>
}

/** The hub didn't start, or refused to stream the device. */
export class DeviceStreamUnavailable extends Error {
  constructor(detail: string) {
    super(`The Device Host can't stream the device: ${detail}`)
    this.name = "DeviceStreamUnavailable"
  }
}

export interface DeviceHubOptions {
  /** Starts a hub on loopback `port`. The live one runs the pinned CLI. */
  readonly spawn: (port: number) => ChildProcess
  /** Where the hub's output goes, its tokens already redacted. */
  readonly log: (line: string) => void
  /** How long a start may take before the hub is restarted. */
  readonly readyTimeoutMilliseconds?: number
}

const defaultReadyTimeoutMilliseconds = 30_000
// A hub that ran this long before exiting restarts at once; one that keeps
// exiting sooner backs off, doubling up to the maximum.
const stableUptimeMilliseconds = 60_000
const maxRestartDelayMilliseconds = 30_000
const attachTimeoutMilliseconds = 60_000
const stopTimeoutMilliseconds = 10_000

/** The link the hub prints once it listens: `Local: http://localhost:<port>/?token=<token>` */
const startupLink = /^\s*Local:\s+http:\/\/\S+?\/\?token=([A-Za-z0-9._~-]+)\s*$/

/**
 * Supervises one hub, bound to loopback with its own token required, and
 * restarts it when it exits. The token comes from the hub's startup link and
 * only the proxy and `attach` ever send it.
 */
export class DeviceHub implements DeviceStream {
  readonly #options: DeviceHubOptions
  #child: ChildProcess | undefined
  /** Settles once the running child's output has closed after it exited. */
  #closed: Promise<void> | undefined
  #endpoint: HubEndpoint | undefined
  #stopped = false
  #restartDelay = 0
  #restartTimer: ReturnType<typeof setTimeout> | undefined
  #waiters: Array<() => void> = []

  constructor(options: DeviceHubOptions) {
    this.#options = options
  }

  endpoint(): HubEndpoint | undefined {
    return this.#endpoint
  }

  start(): void {
    void this.#spawn()
  }

  /** The running hub, waiting up to `timeoutMilliseconds` for one. */
  async ready(
    timeoutMilliseconds = this.#options.readyTimeoutMilliseconds ??
      defaultReadyTimeoutMilliseconds
  ): Promise<HubEndpoint | undefined> {
    if (this.#endpoint !== undefined || this.#stopped) return this.#endpoint
    let timer: ReturnType<typeof setTimeout> | undefined
    await new Promise<void>((resolve) => {
      this.#waiters.push(resolve)
      timer = setTimeout(resolve, timeoutMilliseconds)
    })
    clearTimeout(timer)
    return this.#endpoint
  }

  /**
   * Booting alone attaches no serve-sim helper; the grid start does, and is
   * idempotent for a booted simulator (T3 Code's DeviceHubOperations).
   */
  async attach(deviceUDID: string): Promise<void> {
    const hub = await this.ready()
    if (hub === undefined) {
      throw new DeviceStreamUnavailable("the device hub isn't running.")
    }
    const response = await fetch(
      `${hub.origin}/vendor/serve-sim/grid/api/start`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${hub.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ udid: deviceUDID }),
        signal: AbortSignal.timeout(attachTimeoutMilliseconds),
      }
    ).catch(() => undefined)
    const result = (await response?.json().catch(() => undefined)) as
      { ok?: boolean; error?: string } | undefined
    if (response?.ok !== true || result?.ok !== true) {
      throw new DeviceStreamUnavailable(
        result?.error ?? "the device hub didn't attach the device."
      )
    }
  }

  /** Stops the hub for good, waiting for it to exit. */
  async stop(): Promise<void> {
    this.#stopped = true
    this.#endpoint = undefined
    clearTimeout(this.#restartTimer)
    this.#settle()
    const child = this.#child
    if (child === undefined) return
    child.kill("SIGTERM")
    const timer = setTimeout(
      () => child.kill("SIGKILL"),
      stopTimeoutMilliseconds
    )
    await this.#closed
    clearTimeout(timer)
  }

  /** On the server's own exit, where nothing can be awaited any more. */
  stopNow(): void {
    this.#stopped = true
    clearTimeout(this.#restartTimer)
    this.#child?.kill("SIGTERM")
  }

  async #spawn(): Promise<void> {
    if (this.#stopped) return
    const startedAt = Date.now()
    let child: ChildProcess
    let port: number
    try {
      port = await freeLoopbackPort()
      if (this.#stopped) return
      child = this.#options.spawn(port)
    } catch (error) {
      this.#options.log(`The device hub couldn't start: ${String(error)}`)
      this.#restart(startedAt)
      return
    }
    this.#child = child
    this.#closed = new Promise((resolve) =>
      child.once("close", () => resolve())
    )
    let token: string | undefined
    const redact = (line: string) =>
      (token === undefined ? line : line.split(token).join("…")).replace(
        /([?&]token=)[A-Za-z0-9._~-]+/g,
        "$1…"
      )
    const readyTimer = setTimeout(() => {
      if (token === undefined) {
        this.#options.log("The device hub didn't start in time; restarting it.")
        child.kill("SIGKILL")
      }
    }, this.#options.readyTimeoutMilliseconds ?? defaultReadyTimeoutMilliseconds)

    for (const output of [child.stdout, child.stderr]) {
      if (output === null) continue
      createInterface({ input: output }).on("line", (line) => {
        const link = token === undefined ? startupLink.exec(line) : null
        if (link !== null && this.#child === child) {
          token = link[1]!
          clearTimeout(readyTimer)
          this.#endpoint = { origin: `http://127.0.0.1:${port}`, token }
          this.#settle()
        }
        if (line.trim() !== "") this.#options.log(redact(line))
      })
    }

    let ended = false
    const end = (how: string) => {
      clearTimeout(readyTimer)
      if (ended || this.#child !== child) return
      ended = true
      this.#endpoint = undefined
      this.#child = undefined
      if (this.#stopped) return
      this.#options.log(`The device hub exited (${how}); restarting it.`)
      this.#restart(startedAt)
    }
    child.once("error", (error) => {
      this.#options.log(`The device hub failed: ${error.message}`)
      // A hub that never spawned emits no close.
      if (child.pid === undefined) end("never started")
    })
    child.once("close", (code, signal) => end(signal ?? `code ${code}`))
  }

  #restart(startedAt: number): void {
    const stable = Date.now() - startedAt >= stableUptimeMilliseconds
    const delay = stable ? 0 : this.#restartDelay
    this.#restartDelay = stable
      ? 0
      : this.#restartDelay === 0
        ? 1_000
        : Math.min(this.#restartDelay * 2, maxRestartDelayMilliseconds)
    this.#restartTimer = setTimeout(() => void this.#spawn(), delay)
  }

  #settle(): void {
    for (const resolve of this.#waiters.splice(0)) resolve()
  }
}

/**
 * The live hub: the pinned expo-device-hub CLI on the server's own Node,
 * bound to loopback, requiring its token, streaming iOS simulators through
 * serve-sim and Android emulators through serve-emu. It gets the server's
 * environment minus nitpick's own keys, so no nitpick secret reaches it,
 * plus the Android SDK and ffmpeg the server found: serve-emu runs `adb`
 * from `PATH`.
 */
export function spawnPinnedHub(
  port: number,
  tools: { readonly android: AndroidSDK; readonly ffmpeg: string | undefined }
): ChildProcess {
  return spawn(
    process.execPath,
    [
      hubCLIPath(),
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--require-token",
    ],
    {
      env: hubEnvironment(process.env, tools),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    }
  )
}

export function hubEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  { android, ffmpeg }: Parameters<typeof spawnPinnedHub>[1]
): Record<string, string | undefined> {
  return {
    ...Object.fromEntries(
      Object.entries(environment).filter(([key]) => !key.startsWith("NITPICK_"))
    ),
    ANDROID_HOME: android.root,
    ANDROID_AVD_HOME: android.avdHome,
    PATH: [dirname(android.adb), dirname(android.emulator), environment.PATH]
      .filter((entry) => entry !== undefined && entry !== "")
      .join(delimiter),
    ...(ffmpeg !== undefined && { SERVE_EMU_FFMPEG: ffmpeg }),
  }
}

function hubCLIPath(): string {
  const packageJSON = createRequire(import.meta.url).resolve(
    "expo-device-hub/package.json"
  )
  const { bin } = JSON.parse(readFileSync(packageJSON, "utf8")) as {
    bin: Record<string, string>
  }
  return join(dirname(packageJSON), bin["expo-device-hub"]!)
}

/** A port nothing on loopback listens on now, for the hub to take. */
function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() =>
        typeof address === "object" && address !== null
          ? resolve(address.port)
          : reject(new Error("No loopback port was free."))
      )
    })
  })
}
