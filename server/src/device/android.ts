// Typed adb and emulator actions for Android emulators, the Android half of
// simctl.ts (issue 13). Each builds a fixed argument array for the
// subprocess seam. adb joins a `shell` command's arguments into one line for
// the device's shell, so anything that isn't a fixed word is checked against
// a strict pattern and single-quoted first.
import { constants } from "node:fs"
import { access, readdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { delimiter, isAbsolute, join } from "node:path"
import type { AndroidDeviceSettings } from "@nitpick/core"
import { packageName } from "../buildIngestion.ts"
import {
  SubprocessFailure,
  type ProcessStarter,
  type SubprocessCommand,
  type SubprocessRunner,
} from "../subprocess.ts"
import type {
  AndroidProblem,
  ScreenCapture,
  SimulatorDevice,
} from "./DeviceHost.ts"
import {
  CaptureUnreadable,
  DeviceNotRunning,
  runRequiringSuccess,
  RuntimeUnavailable,
} from "./simctl.ts"

/** Where the host's Android tools and AVDs are. */
export interface AndroidSDK {
  readonly root: string
  readonly adb: string
  readonly emulator: string
  /** Where the AVDs are defined, as the emulator itself looks them up. */
  readonly avdHome: string
}

type Environment = Readonly<Record<string, string | undefined>>

/**
 * The SDK the Android tools agree on: `ANDROID_HOME`, the deprecated
 * `ANDROID_SDK_ROOT`, else Android Studio's default folder on a Mac. AVDs
 * live in `ANDROID_AVD_HOME`, else `~/.android/avd`.
 */
export function androidSDK(
  environment: Environment,
  home = homedir()
): AndroidSDK {
  const root =
    nonEmpty(environment.ANDROID_HOME) ??
    nonEmpty(environment.ANDROID_SDK_ROOT) ??
    join(home, "Library", "Android", "sdk")
  return {
    root,
    adb: join(root, "platform-tools", "adb"),
    emulator: join(root, "emulator", "emulator"),
    avdHome:
      nonEmpty(environment.ANDROID_AVD_HOME) ?? join(home, ".android", "avd"),
  }
}

/**
 * The newest build-tools' `aapt2`, which reads an uploaded APK's identity,
 * or undefined when no build-tools are installed.
 */
export async function aapt2Path(sdk: AndroidSDK): Promise<string | undefined> {
  const directory = join(sdk.root, "build-tools")
  const versions = await readdir(directory).catch(() => [])
  const newest = versions
    .filter((name) => /^[0-9]+(\.[0-9]+)*/.test(name))
    .sort((lhs, rhs) => compareVersions(numbers(rhs), numbers(lhs)))
  for (const version of newest) {
    const path = join(directory, version, "aapt2")
    if (await isExecutable(path)) return path
  }
  return undefined
}

/**
 * The `ffmpeg` serve-emu encodes the emulator's screen with: the one
 * `SERVE_EMU_FFMPEG` names, else the first on `PATH` or in Homebrew's
 * prefixes, which a service's short `PATH` misses.
 */
export async function ffmpegPath(
  environment: Environment
): Promise<string | undefined> {
  const named = nonEmpty(environment.SERVE_EMU_FFMPEG)
  if (named !== undefined) return named
  const directories = [
    ...(environment.PATH ?? "").split(delimiter),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ].filter((directory) => isAbsolute(directory))
  for (const directory of directories) {
    const path = join(directory, "ffmpeg")
    if (await isExecutable(path)) return path
  }
  return undefined
}

/**
 * Probes what an Android review needs, cheapest first: adb, the emulator,
 * build-tools to read an APK, an ffmpeg with libx264 for serve-emu's
 * stream, and at least one AVD whose system image is installed.
 */
export async function checkAndroidHealth(
  runner: SubprocessRunner,
  sdk: AndroidSDK,
  ffmpegReady: () => Promise<boolean>
): Promise<
  | { readonly status: "ready"; readonly devices: SimulatorDevice[] }
  | { readonly status: "notReady"; readonly problem: AndroidProblem }
> {
  const notReady = (kind: AndroidProblem["kind"]) =>
    ({ status: "notReady", problem: { kind } }) as const
  if (!(await isExecutable(sdk.adb))) return notReady("sdkMissing")
  if (!(await isExecutable(sdk.emulator))) return notReady("emulatorMissing")
  if ((await aapt2Path(sdk)) === undefined) return notReady("buildToolsMissing")
  if (!(await ffmpegReady())) return notReady("ffmpegMissing")
  const devices = await listAndroidDevices(runner, sdk).catch(() => [])
  if (!devices.some((device) => device.isRuntimeAvailable)) {
    return notReady("noEmulator")
  }
  return { status: "ready", devices }
}

/** Whether `ffmpeg` runs and has the encoder serve-emu streams with. */
export async function hasLibx264(
  runner: SubprocessRunner,
  ffmpeg: string
): Promise<boolean> {
  try {
    const result = await runner.run({
      executablePath: ffmpeg,
      arguments: ["-hide_banner", "-encoders"],
    })
    return (
      result.exitCode === 0 && /\blibx264\b/.test(String(result.standardOutput))
    )
  } catch {
    return false
  }
}

/**
 * The AVDs the emulator knows, newest Android first, then by name, each
 * named as the AVD Manager shows it. A running one is booted and carries
 * its adb serial. An AVD whose system image is gone stays listed, flagged,
 * as a simulator with a missing runtime does.
 */
export async function listAndroidDevices(
  runner: SubprocessRunner,
  sdk: AndroidSDK
): Promise<SimulatorDevice[]> {
  const listed = await runRequiringSuccess(runner, {
    executablePath: sdk.emulator,
    arguments: ["-list-avds"],
  })
  const names = String(listed.standardOutput)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => avdName.test(line))
  const running = await runningEmulators(runner, sdk)
  const devices = await Promise.all(
    names.map(async (name) => {
      const avd = await readAVD(sdk, name)
      const serial = running.get(name)
      return {
        device: {
          udid: name,
          name: avd.displayName,
          osName:
            avd.release === undefined ? "Android" : `Android ${avd.release}`,
          isBooted: serial !== undefined,
          isRuntimeAvailable: avd.release !== undefined,
          platform: "android",
          ...(serial !== undefined && { serial }),
        } satisfies SimulatorDevice,
        version: numbers(avd.release ?? ""),
      }
    })
  )
  return devices
    .sort(
      (lhs, rhs) =>
        compareVersions(rhs.version, lhs.version) ||
        compareStrings(lhs.device.name, rhs.device.name)
    )
    .map(({ device }) => device)
}

/** AVD names as the AVD Manager allows them. */
const avdName = /^[A-Za-z0-9._-]+$/
const emulatorSerial = /^emulator-[0-9]+$/

/** The running emulators by AVD name: `adb devices`, then each one's name. */
async function runningEmulators(
  runner: SubprocessRunner,
  sdk: AndroidSDK
): Promise<Map<string, string>> {
  const listed = await runRequiringSuccess(runner, {
    executablePath: sdk.adb,
    arguments: ["devices"],
  })
  const serials = String(listed.standardOutput)
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(
      ([serial, state]) =>
        emulatorSerial.test(serial ?? "") && state === "device"
    )
    .map(([serial]) => serial!)
  const named = await Promise.all(
    serials.map(async (serial) => {
      const result = await runner.run(adb(sdk, serial, "emu", "avd", "name"))
      const name = String(result.standardOutput).split(/\r?\n/)[0]?.trim()
      return result.exitCode === 0 && name !== undefined && avdName.test(name)
        ? ([name, serial] as const)
        : undefined
    })
  )
  return new Map(named.filter((entry) => entry !== undefined))
}

/**
 * What the AVD's own files say: its display name, and the Android release
 * of its system image, absent when the image isn't installed.
 */
async function readAVD(
  sdk: AndroidSDK,
  name: string
): Promise<{ readonly displayName: string; readonly release?: string }> {
  const pointer = await readProperties(join(sdk.avdHome, `${name}.ini`))
  const path = pointer.get("path") ?? join(sdk.avdHome, `${name}.avd`)
  const config = await readProperties(join(path, "config.ini"))
  const displayName =
    nonEmpty(config.get("avd.ini.displayname")) ?? name.replaceAll("_", " ")
  const image = config.get("image.sysdir.1")
  if (image === undefined) return { displayName }
  const build = await readProperties(join(sdk.root, image, "build.prop"))
  const release =
    build.get("ro.system.build.version.release") ??
    build.get("ro.build.version.release")
  return /^[0-9]+(\.[0-9]+)*$/.test(release ?? "")
    ? { displayName, release }
    : { displayName }
}

/** An emulator didn't come up within the boot timeout. */
export class EmulatorBootTimedOut extends Error {
  constructor(device: SimulatorDevice) {
    super(
      `${device.name} didn't finish booting on the Device Host. Try again, or ask whoever runs the Device Host.`
    )
    this.name = "EmulatorBootTimedOut"
  }
}

export interface BootOptions {
  /** Waits between polls; tests pass one that returns at once. */
  readonly wait?: (milliseconds: number) => Promise<void>
  readonly timeoutMilliseconds?: number
}

const pollMilliseconds = 1_000
const bootTimeoutMilliseconds = 180_000

/**
 * Boots the AVD headless unless it runs, and answers its serial once
 * Android reports the boot complete. The emulator outlives the request, as
 * a booted simulator does; one that doesn't finish booting is shut down.
 */
export async function bootEmulator(
  runner: SubprocessRunner,
  starter: ProcessStarter,
  sdk: AndroidSDK,
  device: SimulatorDevice,
  options: BootOptions = {}
): Promise<string> {
  if (!device.isRuntimeAvailable) throw new RuntimeUnavailable(device)
  const wait = options.wait ?? sleep
  const deadline =
    (options.timeoutMilliseconds ?? bootTimeoutMilliseconds) / pollMilliseconds
  let serial = (await runningEmulators(runner, sdk)).get(device.udid)
  // An emulator restored from its snapshot reports the boot complete at
  // once, then drops adb for a moment: one it starts has to look booted on
  // two polls in a row.
  const healthyPollsNeeded = serial === undefined ? 2 : 1
  if (serial === undefined) {
    starter.start({
      executablePath: sdk.emulator,
      arguments: [
        "-avd",
        device.udid,
        "-no-window",
        "-no-audio",
        "-no-boot-anim",
      ],
    })
  }
  let healthyPolls = 0
  for (let poll = 0; poll < deadline; poll++) {
    serial ??= (await runningEmulators(runner, sdk)).get(device.udid)
    healthyPolls =
      serial !== undefined && (await isBooted(runner, sdk, serial))
        ? healthyPolls + 1
        : 0
    if (serial !== undefined && healthyPolls >= healthyPollsNeeded) {
      return serial
    }
    await wait(pollMilliseconds)
  }
  if (serial !== undefined) await shutdownEmulator(runner, sdk, serial)
  throw new EmulatorBootTimedOut(device)
}

/** Android says the boot is complete, and its package manager answers. */
async function isBooted(
  runner: SubprocessRunner,
  sdk: AndroidSDK,
  serial: string
): Promise<boolean> {
  const completed = await runner.run(
    adb(sdk, serial, "shell", "getprop", "sys.boot_completed")
  )
  if (
    completed.exitCode !== 0 ||
    String(completed.standardOutput).trim() !== "1"
  ) {
    return false
  }
  const framework = await runner.run(
    adb(sdk, serial, "shell", "pm", "path", "android")
  )
  return (
    framework.exitCode === 0 &&
    String(framework.standardOutput).startsWith("package:")
  )
}

const installRetries = 2
const installRetryMilliseconds = 2_000

/** adb lost the device, as opposed to Android refusing the install. */
function isTransientADBFailure(result: {
  readonly exitCode: number
  readonly standardOutput: Buffer
  readonly standardError: Buffer
}): boolean {
  return (
    result.exitCode !== 0 &&
    /device offline|Error: closed|device '[^']*' not found|no devices\/emulators found/.test(
      `${result.standardOutput}${result.standardError}`
    )
  )
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/** Stops a running emulator, as closing its window would. */
export async function shutdownEmulator(
  runner: SubprocessRunner,
  sdk: AndroidSDK,
  serial: string
): Promise<void> {
  await runner.run(adb(sdk, serial, "emu", "kill"))
}

const componentName = /^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/

/** The Build installed, but Android found nothing to open in it. */
export class NoLauncherActivity extends Error {
  constructor(packageID: string) {
    super(`${packageID} has no launcher activity, so nitpick can't open it.`)
    this.name = "NoLauncherActivity"
  }
}

/**
 * Installs the APK over whatever the emulator has, and opens its launcher
 * activity. An older version, or one signed with another key, replaces the
 * installed app, as `simctl install` does: the review device's app data
 * goes with it.
 */
export async function installAndLaunch(
  runner: SubprocessRunner,
  sdk: AndroidSDK,
  serial: string,
  apk: { readonly path: string; readonly packageID: string },
  { wait = sleep }: Pick<BootOptions, "wait"> = {}
): Promise<void> {
  if (!packageName.test(apk.packageID))
    throw new NoLauncherActivity(apk.packageID)
  const install = adb(sdk, serial, "install", "-r", "-t", "-d", apk.path)
  // A just-booted emulator can still drop adb for a moment.
  let installed = await runner.run(install)
  for (
    let retry = 0;
    retry < installRetries && isTransientADBFailure(installed);
    retry++
  ) {
    await wait(installRetryMilliseconds)
    installed = await runner.run(install)
  }
  if (installed.exitCode !== 0) {
    const output = `${installed.standardOutput}${installed.standardError}`
    if (
      !/INSTALL_FAILED_(UPDATE_INCOMPATIBLE|VERSION_DOWNGRADE)/.test(output)
    ) {
      throw new SubprocessFailure(install, installed.exitCode, output)
    }
    await runner.run(adb(sdk, serial, "uninstall", apk.packageID))
    await runRequiringSuccess(runner, install)
  }
  const resolved = await runRequiringSuccess(
    runner,
    adb(
      sdk,
      serial,
      "shell",
      "cmd",
      "package",
      "resolve-activity",
      "--brief",
      "-c",
      "android.intent.category.LAUNCHER",
      apk.packageID
    )
  )
  const component = String(resolved.standardOutput)
    .trim()
    .split(/\r?\n/)
    .at(-1)
    ?.trim()
  if (component === undefined || !componentName.test(component)) {
    throw new NoLauncherActivity(apk.packageID)
  }
  const start = adb(
    sdk,
    serial,
    "shell",
    "am",
    "start",
    "-W",
    "-n",
    deviceShellQuoted(component)
  )
  const started = await runRequiringSuccess(runner, start)
  // `am start` exits 0 even when it couldn't start anything.
  const output = `${started.standardOutput}${started.standardError}`
  if (/^Error/m.test(output)) {
    throw new Error(`Android couldn't open ${apk.packageID}: ${output.trim()}`)
  }
}

/**
 * The emulator's screen at native pixels, `screencap`'s own PNG and never a
 * stream frame, with the accessibility state it was taken under. A device
 * that isn't running refuses first; the reads run beside the screenshot.
 */
export async function captureEmulator(
  runner: SubprocessRunner,
  sdk: AndroidSDK,
  device: SimulatorDevice | undefined
): Promise<ScreenCapture> {
  if (device?.serial === undefined || !device.isBooted) {
    throw new DeviceNotRunning(device?.name ?? "The device")
  }
  const serial = device.serial
  const settings = androidSettings(runner, sdk, serial)
  settings.catch(() => {})
  const result = await runRequiringSuccess(
    runner,
    adb(sdk, serial, "exec-out", "screencap", "-p")
  )
  const png = result.standardOutput
  if (!png.subarray(0, 8).equals(pngSignature)) throw new CaptureUnreadable()
  return { device, png, settings: await settings }
}

const pngSignature = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
])

/**
 * The emulator's live accessibility state (ADR-0013). Each read that can't
 * be parsed reads as that setting's default, so the Accessibility line
 * never carries a raw value. The dark theme is `dumpsys uimode`'s computed
 * night mode: `cmd uimode night` names a schedule, not what is in effect.
 */
export async function androidSettings(
  runner: SubprocessRunner,
  sdk: AndroidSDK,
  serial: string
): Promise<AndroidDeviceSettings> {
  const read = async (...command: string[]) =>
    String(
      (await runRequiringSuccess(runner, adb(sdk, serial, "shell", ...command)))
        .standardOutput
    ).trim()
  const [fontScale, uiMode, highContrastText] = await Promise.all([
    read("settings", "get", "system", "font_scale"),
    read("dumpsys", "uimode"),
    read("settings", "get", "secure", "high_text_contrast_enabled"),
  ])
  const scale = Number(fontScale)
  return {
    platform: "android",
    fontScale: /^[0-9]+(\.[0-9]+)?$/.test(fontScale) && scale > 0 ? scale : 1,
    darkTheme: isDarkTheme(uiMode),
    highContrastText: highContrastText === "1",
  }
}

function isDarkTheme(uiMode: string): boolean {
  const computed = /\bmComputedNightMode=(true|false)\b/.exec(uiMode)
  if (computed !== null) return computed[1] === "true"
  // Configuration.UI_MODE_NIGHT_MASK and UI_MODE_NIGHT_YES.
  const current = /\bmCurUiMode=0x([0-9a-f]+)\b/i.exec(uiMode)
  return current !== null && (parseInt(current[1]!, 16) & 0x30) === 0x20
}

function adb(
  sdk: AndroidSDK,
  serial: string,
  ...adbArguments: string[]
): SubprocessCommand {
  return { executablePath: sdk.adb, arguments: ["-s", serial, ...adbArguments] }
}

/** One argument for the device's `sh`, which adb hands the joined line. */
function deviceShellQuoted(argument: string): string {
  return `'${argument.replaceAll("'", `'\\''`)}'`
}

/** A `key=value` file such as an AVD's `config.ini`; empty when unreadable. */
async function readProperties(path: string): Promise<Map<string, string>> {
  const text = await readFile(path, "utf8").catch(() => "")
  const properties = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf("=")
    if (separator <= 0 || line.startsWith("#")) continue
    properties.set(
      line.slice(0, separator).trim(),
      line.slice(separator + 1).trim()
    )
  }
  return properties
}

async function isExecutable(path: string): Promise<boolean> {
  return access(path, constants.X_OK).then(
    () => true,
    () => false
  )
}

function numbers(version: string): number[] {
  return version.split(".").map(Number).filter(Number.isFinite)
}

function compareVersions(lhs: number[], rhs: number[]): number {
  for (let index = 0; index < Math.min(lhs.length, rhs.length); index++) {
    const difference = lhs[index]! - rhs[index]!
    if (difference !== 0) return difference
  }
  return lhs.length - rhs.length
}

function compareStrings(lhs: string, rhs: string): number {
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === "" ? undefined : trimmed
}
