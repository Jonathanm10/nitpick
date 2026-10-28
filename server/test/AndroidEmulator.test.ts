// Not a port: the Swift app has no Android. The typed adb, emulator and
// aapt2 actions, against the output those tools gave on a headless
// emulator (Android 17, emulator 36.5, adb 37), with an SDK and AVD home
// laid out on disk.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { BuildIngestError, readBuildFromAPK } from "../src/buildIngestion.ts"
import {
  androidSDK,
  androidSettings,
  bootEmulator,
  captureEmulator,
  checkAndroidHealth,
  EmulatorBootTimedOut,
  installAndLaunch,
  listAndroidDevices,
  NoLauncherActivity,
  type AndroidSDK,
} from "../src/device/android.ts"
import type { SimulatorDevice } from "../src/device/DeviceHost.ts"
import { hubEnvironment } from "../src/device/deviceHub.ts"
import { DeviceNotRunning } from "../src/device/simctl.ts"
import type { SubprocessCommand } from "../src/subprocess.ts"
import { temporaryDirectory } from "./BuildFixtures.ts"
import { FakeSubprocessRunner } from "./FakeSubprocessRunner.ts"

const image =
  "system-images/android-37.0/google_apis_playstore_ps16k/arm64-v8a/"

/** An SDK with adb, the emulator and build-tools, and the AVDs named. */
function sdkWith(
  avds: ReadonlyArray<{ name: string; displayName?: string; release?: string }>,
  { tools = true } = {}
): AndroidSDK {
  const root = temporaryDirectory()
  const sdk = androidSDK({
    ANDROID_HOME: root,
    ANDROID_AVD_HOME: join(root, "avd"),
  })
  if (tools) {
    for (const tool of [
      sdk.adb,
      sdk.emulator,
      join(root, "build-tools", "37.0.0", "aapt2"),
    ]) {
      mkdirSync(join(tool, ".."), { recursive: true })
      writeFileSync(tool, "")
      chmodSync(tool, 0o755)
    }
  }
  for (const avd of avds) {
    const path = join(sdk.avdHome, `${avd.name}.avd`)
    mkdirSync(path, { recursive: true })
    writeFileSync(
      join(sdk.avdHome, `${avd.name}.ini`),
      `avd.ini.encoding=UTF-8\npath=${path}\ntarget=android-37.0\n`
    )
    writeFileSync(
      join(path, "config.ini"),
      [
        `AvdId=${avd.name}`,
        ...(avd.displayName === undefined
          ? []
          : [`avd.ini.displayname=${avd.displayName}`]),
        // An AVD without a release names an image that was never installed.
        `image.sysdir.1=${avd.release === undefined ? "system-images/android-36/google_apis/arm64-v8a/" : image}`,
      ].join("\n")
    )
    if (avd.release !== undefined) {
      mkdirSync(join(root, image), { recursive: true })
      writeFileSync(
        join(root, image, "build.prop"),
        `ro.system.build.version.release=${avd.release}\nro.build.version.sdk=37\n`
      )
    }
  }
  return sdk
}

const proof = {
  name: "nitpick-proof-13",
  displayName: "Pixel 10",
  release: "17",
}

function enqueueListing(
  runner: FakeSubprocessRunner,
  names: string,
  running: ReadonlyArray<{ serial: string; name: string }> = []
) {
  runner.enqueue({ exitCode: 0, standardOutput: names })
  runner.enqueue({
    exitCode: 0,
    standardOutput: `List of devices attached\n${running.map(({ serial }) => `${serial}\tdevice\n`).join("")}\n`,
  })
  for (const { name } of running) {
    runner.enqueue({ exitCode: 0, standardOutput: `${name}\r\nOK\r\n` })
  }
}

function commandLine(command: SubprocessCommand): string {
  return [command.executablePath.split("/").at(-1), ...command.arguments].join(
    " "
  )
}

const emulatorDevice: SimulatorDevice = {
  udid: "nitpick-proof-13",
  name: "Pixel 10",
  osName: "Android 17",
  isBooted: true,
  isRuntimeAvailable: true,
  platform: "android",
  serial: "emulator-5554",
}

describe("listing AVDs", () => {
  test("each AVD shows as the AVD Manager names it, with its image's Android release, and a running one carries its serial", async () => {
    const sdk = sdkWith([proof, { name: "Spare_Phone" }])
    const runner = new FakeSubprocessRunner()
    enqueueListing(runner, "Spare_Phone\nnitpick-proof-13\n", [
      { serial: "emulator-5554", name: "nitpick-proof-13" },
    ])

    const devices = await listAndroidDevices(runner, sdk)

    expect(devices).toEqual([
      emulatorDevice,
      {
        udid: "Spare_Phone",
        name: "Spare Phone",
        osName: "Android",
        isBooted: false,
        isRuntimeAvailable: false,
        platform: "android",
      },
    ])
    expect(runner.executedCommands.map(commandLine)).toEqual([
      "emulator -list-avds",
      "adb devices",
      "adb -s emulator-5554 emu avd name",
    ])
  })

  test("a device that isn't an emulator, or is offline, isn't one of the AVDs", async () => {
    const sdk = sdkWith([proof])
    const runner = new FakeSubprocessRunner()
    runner.enqueue({ exitCode: 0, standardOutput: "nitpick-proof-13\n" })
    runner.enqueue({
      exitCode: 0,
      standardOutput:
        "List of devices attached\nR58N12ABC\tdevice\nemulator-5556\toffline\n\n",
    })

    const [device] = await listAndroidDevices(runner, sdk)

    expect(device?.isBooted).toBe(false)
    expect(runner.executedCommands).toHaveLength(2)
  })
})

describe("the Android health check", () => {
  test("names the first thing missing, cheapest first", async () => {
    const runner = new FakeSubprocessRunner()
    const ready = async () => true

    const noSDK = await checkAndroidHealth(
      runner,
      sdkWith([], { tools: false }),
      ready
    )
    const noFFmpeg = await checkAndroidHealth(
      runner,
      sdkWith([proof]),
      async () => false
    )
    const noAVD = sdkWith([])
    runner.enqueue({ exitCode: 0, standardOutput: "" })
    runner.enqueue({
      exitCode: 0,
      standardOutput: "List of devices attached\n\n",
    })
    const noEmulator = await checkAndroidHealth(runner, noAVD, ready)

    expect([noSDK, noFFmpeg, noEmulator]).toEqual([
      { status: "notReady", problem: { kind: "sdkMissing" } },
      { status: "notReady", problem: { kind: "ffmpegMissing" } },
      { status: "notReady", problem: { kind: "noEmulator" } },
    ])
  })

  test("is ready with the AVDs once an image is installed", async () => {
    const runner = new FakeSubprocessRunner()
    enqueueListing(runner, "nitpick-proof-13\n")

    const health = await checkAndroidHealth(
      runner,
      sdkWith([proof]),
      async () => true
    )

    expect(health).toEqual({
      status: "ready",
      devices: [
        {
          udid: "nitpick-proof-13",
          name: "Pixel 10",
          osName: "Android 17",
          isBooted: false,
          isRuntimeAvailable: true,
          platform: "android",
        },
      ],
    })
  })
})

describe("booting", () => {
  const stopped = { ...emulatorDevice, isBooted: false, serial: undefined }

  /** Records what it starts, and whether each was stopped. */
  function starting(started: SubprocessCommand[], stops: string[] = []) {
    return {
      start: (command: SubprocessCommand) => {
        started.push(command)
        return { stop: () => stops.push(commandLine(command)) }
      },
    }
  }

  /**
   * The emulator over time: `adb devices` lists it from the `listed`th
   * call, and each readiness poll answers the next of `polls` (the boot flag
   * and whether the package manager answers), the last one repeating.
   */
  function emulatorBooting({
    listed = 1,
    polls,
  }: {
    listed?: number
    polls: ReadonlyArray<{ booted: boolean; packageManager: boolean }>
  }) {
    const runner = new FakeSubprocessRunner()
    let listings = 0
    let poll = -1
    runner.run = async (command) => {
      runner.executedCommands.push(command)
      const line = command.arguments.join(" ")
      const answer = (standardOutput: string, exitCode = 0) => ({
        exitCode,
        standardOutput: Buffer.from(standardOutput),
        standardError: Buffer.alloc(0),
      })
      if (line === "devices") {
        return answer(
          listings++ >= listed - 1
            ? "List of devices attached\nemulator-5554\tdevice\n"
            : "List of devices attached\n\n"
        )
      }
      if (line.endsWith("emu avd name"))
        return answer("nitpick-proof-13\r\nOK\r\n")
      if (line.endsWith("getprop sys.boot_completed")) {
        poll = Math.min(poll + 1, polls.length - 1)
        return answer(polls[poll]!.booted ? "1\n" : "\n")
      }
      if (line.endsWith("pm path android")) {
        return polls[poll]!.packageManager
          ? answer("package:/system/framework/framework-res.apk\n")
          : answer("", 255)
      }
      return answer("OK\r\n")
    }
    return runner
  }

  const ready = { booted: true, packageManager: true }

  test("starts the AVD headless, then waits for its serial and a boot that holds on two polls", async () => {
    const runner = emulatorBooting({
      listed: 2,
      polls: [{ booted: false, packageManager: false }, ready, ready],
    })
    const started: SubprocessCommand[] = []

    const serial = await bootEmulator(
      runner,
      starting(started),
      sdkWith([proof]),
      stopped,
      { wait: async () => {} }
    )

    expect(serial).toBe("emulator-5554")
    expect(started.map(commandLine)).toEqual([
      "emulator -avd nitpick-proof-13 -no-window -no-audio -no-boot-anim",
    ])
    expect(
      runner.executedCommands
        .map(commandLine)
        .filter((line) => line.includes("boot_completed"))
    ).toHaveLength(3)
  })

  test("a snapshot that reports the boot at once, then drops adb, isn't booted yet", async () => {
    const runner = emulatorBooting({
      listed: 2,
      polls: [ready, { booted: false, packageManager: false }, ready, ready],
    })

    await bootEmulator(runner, starting([]), sdkWith([proof]), stopped, {
      wait: async () => {},
    })

    expect(
      runner.executedCommands
        .map(commandLine)
        .filter((line) => line.includes("boot_completed"))
    ).toHaveLength(4)
  })

  test("a package manager that doesn't answer yet isn't a boot", async () => {
    const runner = emulatorBooting({
      listed: 2,
      polls: [
        { booted: true, packageManager: false },
        { booted: true, packageManager: false },
        ready,
        ready,
      ],
    })

    await bootEmulator(runner, starting([]), sdkWith([proof]), stopped, {
      wait: async () => {},
    })

    expect(
      runner.executedCommands
        .map(commandLine)
        .filter((line) => line.includes("pm path android"))
    ).toHaveLength(4)
  })

  test("an emulator adb never sees comes down when the boot times out", async () => {
    const runner = emulatorBooting({
      listed: Number.POSITIVE_INFINITY,
      polls: [{ booted: false, packageManager: false }],
    })
    const stops: string[] = []

    const boot = bootEmulator(
      runner,
      starting([], stops),
      sdkWith([proof]),
      stopped,
      { wait: async () => {}, timeoutMilliseconds: 3_000 }
    )

    await expect(boot).rejects.toThrow(EmulatorBootTimedOut)
    expect(stops).toEqual([
      "emulator -avd nitpick-proof-13 -no-window -no-audio -no-boot-anim",
    ])
  })

  test("a running AVD isn't started again, and one healthy poll will do", async () => {
    const runner = emulatorBooting({ polls: [ready] })
    const started: SubprocessCommand[] = []

    await bootEmulator(runner, starting(started), sdkWith([proof]), stopped, {
      wait: async () => {},
    })

    expect(started).toEqual([])
    expect(
      runner.executedCommands
        .map(commandLine)
        .filter((line) => line.includes("boot_completed"))
    ).toHaveLength(1)
  })

  test("an emulator that doesn't finish booting is shut down, and the Reviewer told", async () => {
    const runner = emulatorBooting({
      polls: [{ booted: false, packageManager: false }],
    })

    const boot = bootEmulator(runner, starting([]), sdkWith([proof]), stopped, {
      wait: async () => {},
      timeoutMilliseconds: 3_000,
    })

    await expect(boot).rejects.toThrow(EmulatorBootTimedOut)
    await expect(boot).rejects.toThrow(
      "Pixel 10 didn't finish booting on the Device Host. Try again, or ask whoever runs the Device Host."
    )
    expect(runner.executedCommands.map(commandLine).at(-1)).toBe(
      "adb -s emulator-5554 emu kill"
    )
  })
})

describe("install and launch", () => {
  const apk = {
    path: "/data/builds/1/SmokeDroid.apk",
    packageID: "dev.nitpick.fixture.smokedroid",
  }

  test("installs over what's there, then opens the launcher activity it resolves, quoted for the device's shell", async () => {
    const runner = new FakeSubprocessRunner()
    runner.enqueue({
      exitCode: 0,
      standardOutput: "Performing Streamed Install\nSuccess\n",
    })
    runner.enqueue({
      exitCode: 0,
      standardOutput:
        "priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=false\ndev.nitpick.fixture.smokedroid/.MainActivity$Shown\n",
    })
    runner.enqueue({
      exitCode: 0,
      standardOutput: "Starting: Intent { cmp=… }\nStatus: ok\nComplete\n",
    })

    await installAndLaunch(runner, sdkWith([]), "emulator-5554", apk)

    expect(runner.executedCommands.map((command) => command.arguments)).toEqual(
      [
        ["-s", "emulator-5554", "install", "-r", "-t", "-d", apk.path],
        [
          "-s",
          "emulator-5554",
          "shell",
          "cmd",
          "package",
          "resolve-activity",
          "--brief",
          "-c",
          "android.intent.category.LAUNCHER",
          apk.packageID,
        ],
        [
          "-s",
          "emulator-5554",
          "shell",
          "am",
          "start",
          "-W",
          "-n",
          "'dev.nitpick.fixture.smokedroid/.MainActivity$Shown'",
        ],
      ]
    )
  })

  test("an app signed with another key is replaced, as simctl install replaces one", async () => {
    const runner = new FakeSubprocessRunner()
    runner.enqueue({
      exitCode: 1,
      standardOutput:
        "Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match]\n",
    })
    runner.enqueue({ exitCode: 0, standardOutput: "Success\n" })
    runner.enqueue({ exitCode: 0, standardOutput: "Success\n" })
    runner.enqueue({
      exitCode: 0,
      standardOutput: "dev.nitpick.fixture.smokedroid/.MainActivity\n",
    })
    runner.enqueue({ exitCode: 0, standardOutput: "Status: ok\n" })

    await installAndLaunch(runner, sdkWith([]), "emulator-5554", apk)

    expect(
      runner.executedCommands.map((command) => command.arguments[2])
    ).toEqual(["install", "uninstall", "install", "shell", "shell"])
  })

  test("adb losing a just-booted emulator for a moment is retried", async () => {
    const runner = new FakeSubprocessRunner()
    runner.enqueue({
      exitCode: 1,
      standardError:
        "adb: failed to run abb_exec. Error: closed\nadb: connect error for write: device offline\n",
    })
    runner.enqueue({ exitCode: 0, standardOutput: "Success\n" })
    runner.enqueue({
      exitCode: 0,
      standardOutput: "dev.nitpick.fixture.smokedroid/.MainActivity\n",
    })
    runner.enqueue({ exitCode: 0, standardOutput: "Status: ok\n" })
    const waits: number[] = []

    await installAndLaunch(runner, sdkWith([]), "emulator-5554", apk, {
      wait: async (milliseconds) => {
        waits.push(milliseconds)
      },
    })

    expect(
      runner.executedCommands.map((command) => command.arguments[2])
    ).toEqual(["install", "install", "shell", "shell"])
    expect(waits).toEqual([2_000])
  })

  test("any other install failure stops the launch", async () => {
    const runner = new FakeSubprocessRunner()
    runner.enqueue({
      exitCode: 1,
      standardOutput: "Failure [INSTALL_FAILED_NO_MATCHING_ABIS]\n",
    })

    await expect(
      installAndLaunch(runner, sdkWith([]), "emulator-5554", apk)
    ).rejects.toThrow("INSTALL_FAILED_NO_MATCHING_ABIS")
    expect(runner.executedCommands).toHaveLength(1)
  })

  test("nothing to launch, or a component the device's shell would misread, is refused", async () => {
    for (const resolved of [
      "No activity found\n",
      "dev.nitpick.x/.Main;reboot\n",
    ]) {
      const runner = new FakeSubprocessRunner()
      runner.enqueue({ exitCode: 0, standardOutput: "Success\n" })
      runner.enqueue({ exitCode: 0, standardOutput: resolved })

      await expect(
        installAndLaunch(runner, sdkWith([]), "emulator-5554", apk)
      ).rejects.toThrow(NoLauncherActivity)
      expect(runner.executedCommands).toHaveLength(2)
    }
  })
})

describe("capture", () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("IHDR…"),
  ])

  /** The three reads run beside screencap, so the fake answers by command. */
  function answering(answers: Record<string, string>) {
    const runner = new FakeSubprocessRunner()
    runner.run = async (command) => {
      runner.executedCommands.push(command)
      const line = command.arguments.slice(2).join(" ")
      const output =
        line === "exec-out screencap -p"
          ? png
          : Buffer.from(answers[line] ?? "")
      return {
        exitCode: 0,
        standardOutput: output,
        standardError: Buffer.alloc(0),
      }
    }
    return runner
  }

  const defaults = {
    "shell settings get system font_scale": "null\n",
    "shell dumpsys uimode":
      "  mNightMode=3 (custom_bedtime) mComputedNightMode=false customStart=22:00\n  mCurUiMode=0x11\n",
    "shell settings get secure high_text_contrast_enabled": "null\n",
  }

  test("takes screencap's own PNG with the settings in effect, defaults when unset", async () => {
    const capture = await captureEmulator(
      answering(defaults),
      sdkWith([]),
      emulatorDevice
    )

    expect(capture).toEqual({
      device: emulatorDevice,
      png,
      settings: {
        platform: "android",
        fontScale: 1,
        darkTheme: false,
        highContrastText: false,
      },
    })
  })

  test("reads a larger font, the dark theme in effect, and high-contrast text", async () => {
    const settings = await androidSettings(
      answering({
        "shell settings get system font_scale": "1.3\n",
        "shell dumpsys uimode":
          " mNightMode=2 (yes) mComputedNightMode=true\n mCurUiMode=0x21\n",
        "shell settings get secure high_text_contrast_enabled": "1\n",
      }),
      sdkWith([]),
      "emulator-5554"
    )

    expect(settings).toEqual({
      platform: "android",
      fontScale: 1.3,
      darkTheme: true,
      highContrastText: true,
    })
  })

  test("without the computed night mode, the current UI mode's night bits decide", async () => {
    const read = (uiMode: string) =>
      androidSettings(
        answering({ ...defaults, "shell dumpsys uimode": uiMode }),
        sdkWith([]),
        "emulator-5554"
      )

    expect((await read("mCurUiMode=0x21")).darkTheme).toBe(true)
    expect((await read("mCurUiMode=0x11")).darkTheme).toBe(false)
    expect((await read("unexpected")).darkTheme).toBe(false)
  })

  test("a value that can't be read is that setting's default, never a raw token", async () => {
    const settings = await androidSettings(
      answering({
        ...defaults,
        "shell settings get system font_scale": "1.3x\n",
      }),
      sdkWith([]),
      "emulator-5554"
    )

    expect(settings.fontScale).toBe(1)
  })

  test("a stopped emulator refuses before anything runs", async () => {
    const runner = new FakeSubprocessRunner()
    const stopped = { ...emulatorDevice, isBooted: false, serial: undefined }

    await expect(captureEmulator(runner, sdkWith([]), stopped)).rejects.toThrow(
      DeviceNotRunning
    )
    expect(runner.executedCommands).toEqual([])
  })
})

describe("reading an .apk", () => {
  const badging = (packageLine: string, launchable = true) =>
    [
      `package: ${packageLine} platformBuildVersionName='17' compileSdkVersion='37'`,
      "minSdkVersion:'29'",
      "application: label='SmokeDroid' icon=''",
      ...(launchable
        ? [
            "launchable-activity: name='dev.nitpick.fixture.smokedroid.MainActivity'  label='' icon=''",
          ]
        : []),
    ].join("\n")

  async function read(output: string, exitCode = 0) {
    const runner = new FakeSubprocessRunner()
    runner.enqueue({ exitCode, standardOutput: output })
    return readBuildFromAPK(runner, "/sdk/build-tools/37.0.0/aapt2", {
      path: "/data/builds/1/SmokeDroid.apk",
      name: "SmokeDroid.apk",
    })
  }

  test("its identity is the package name, version name and version code", async () => {
    expect(
      await read(
        badging(
          "name='dev.nitpick.fixture.smokedroid' versionCode='42' versionName='1.4.0'"
        )
      )
    ).toEqual({
      identity: {
        bundleID: "dev.nitpick.fixture.smokedroid",
        version: "1.4.0",
        buildNumber: "42",
      },
      appBundleURL: "file:///data/builds/1/SmokeDroid.apk",
    })
  })

  test.each([
    [
      "aapt2 can't read it",
      "ERROR: dump failed",
      1,
      { kind: "unreadableAPK", apkName: "SmokeDroid.apk" },
    ],
    [
      "its package name isn't one",
      badging("name='$(reboot)' versionCode='1' versionName='1'"),
      0,
      { kind: "unreadableAPK", apkName: "SmokeDroid.apk" },
    ],
    [
      "it has no version name",
      badging("name='dev.nitpick.x' versionCode='42' versionName=''"),
      0,
      {
        kind: "missingManifestKeys",
        apkName: "SmokeDroid.apk",
        keys: ["versionName"],
      },
    ],
    [
      "nothing in it can be launched",
      badging(
        "name='dev.nitpick.x' versionCode='42' versionName='1.4.0'",
        false
      ),
      0,
      { kind: "noLauncherActivity", apkName: "SmokeDroid.apk" },
    ],
  ] as const)("is refused when %s", async (_, output, exitCode, failure) => {
    await expect(read(output, exitCode)).rejects.toThrow(
      new BuildIngestError(failure)
    )
  })
})

describe("the hub's environment", () => {
  test("finds the same SDK and ffmpeg as the server, and none of nitpick's own keys", () => {
    const sdk = androidSDK({ ANDROID_HOME: "/sdk", ANDROID_AVD_HOME: "/avds" })

    expect(
      hubEnvironment(
        {
          PATH: "/usr/bin:/bin",
          NITPICK_YOUTRACK_URL: "https://youtrack.invalid",
          HOME: "/home",
        },
        { android: sdk, ffmpeg: "/opt/homebrew/bin/ffmpeg" }
      )
    ).toEqual({
      PATH: "/sdk/platform-tools:/sdk/emulator:/usr/bin:/bin",
      HOME: "/home",
      ANDROID_HOME: "/sdk",
      ANDROID_AVD_HOME: "/avds",
      SERVE_EMU_FFMPEG: "/opt/homebrew/bin/ffmpeg",
    })
  })
})
