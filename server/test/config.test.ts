import { inspect } from "node:util"
import { describe, expect, test } from "vitest"
import { defaultPort, loadConfig } from "../src/config.ts"

const noFile = (path: string): string => {
  throw new Error(`unexpected read of ${path}`)
}

describe("Server config", () => {
  test("with nothing set, the server listens on loopback at the default port", () => {
    const config = loadConfig({}, noFile)

    expect(config.host).toBe("127.0.0.1")
    expect(config.port).toBe(defaultPort)
    expect(config.dataDirectory).toMatch(
      /Library\/Application Support\/nitpick-server$/
    )
  })

  test("the file NITPICK_CONFIG_FILE names supplies values, and the environment wins over it", () => {
    const files: Record<string, string> = {
      "/config/nitpick.env":
        "NITPICK_HOST=0.0.0.0\nNITPICK_PORT=5000\nNITPICK_DATA_DIR=/data/nitpick\n",
    }

    const config = loadConfig(
      { NITPICK_CONFIG_FILE: "/config/nitpick.env", NITPICK_PORT: "6000" },
      (path) => files[path]
    )

    expect(config).toEqual({
      host: "0.0.0.0",
      port: 6000,
      dataDirectory: "/data/nitpick",
    })
  })

  test("empty values, as in the example file, keep the defaults", () => {
    const config = loadConfig(
      { NITPICK_CONFIG_FILE: "/config/nitpick.env", NITPICK_HOST: "" },
      () => "NITPICK_HOST=\nNITPICK_PORT=\nNITPICK_DATA_DIR=\n"
    )

    expect(config.host).toBe("127.0.0.1")
    expect(config.port).toBe(defaultPort)
  })

  test.each(["0", "65536", "80a", "-1"])("port %s is refused", (port) => {
    expect(() => loadConfig({ NITPICK_PORT: port }, noFile)).toThrow(
      /NITPICK_PORT must be a port number/
    )
  })

  test("the interim YouTrack connection needs both its URL and its token", () => {
    const config = loadConfig(
      {
        NITPICK_YOUTRACK_URL: "youtrack.example.com/",
        NITPICK_YOUTRACK_TOKEN: "perm:server-token",
      },
      noFile
    )

    expect(config.youTrack?.instanceURL).toBe("https://youtrack.example.com")
    expect(config.youTrack?.authorization()).toBe("Bearer perm:server-token")
    expect(() =>
      loadConfig({ NITPICK_YOUTRACK_URL: "youtrack.example.com" }, noFile)
    ).toThrow(
      "NITPICK_YOUTRACK_URL and NITPICK_YOUTRACK_TOKEN must be set together."
    )
    expect(loadConfig({}, noFile).youTrack).toBeUndefined()
  })

  test("the YouTrack token never shows when the config is logged", () => {
    const config = loadConfig(
      {
        NITPICK_YOUTRACK_URL: "https://youtrack.example.com",
        NITPICK_YOUTRACK_TOKEN: "perm:server-token",
      },
      noFile
    )

    expect(inspect(config, { depth: Infinity })).not.toContain("server-token")
    expect(JSON.stringify(config)).not.toContain("server-token")
  })

  test("the device stream's access token is off unless set, can't be short, and never shows when the config is logged", () => {
    expect(loadConfig({}, noFile).streamAccess).toBeUndefined()
    expect(() =>
      loadConfig({ NITPICK_ACCESS_TOKEN: "too-short" }, noFile)
    ).toThrow("NITPICK_ACCESS_TOKEN must be at least 16 characters long.")

    const config = loadConfig(
      { NITPICK_ACCESS_TOKEN: "shared-access-token-for-tests" },
      noFile
    )

    expect(config.streamAccess?.accepts("shared-access-token-for-tests")).toBe(
      true
    )
    expect(config.streamAccess?.accepts("shared-access-token-for-test")).toBe(
      false
    )
    expect(inspect(config, { depth: Infinity })).not.toContain("shared-access")
    expect(JSON.stringify(config)).not.toContain("shared-access")
  })

  test("a YouTrack URL that would send the token in cleartext is refused", () => {
    expect(() =>
      loadConfig(
        {
          NITPICK_YOUTRACK_URL: "http://youtrack.example.com",
          NITPICK_YOUTRACK_TOKEN: "perm:server-token",
        },
        noFile
      )
    ).toThrow(/is not secure/)
  })
})
