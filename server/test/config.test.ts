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

  test("the one YouTrack instance is cleaned up as the Swift app cleaned an entered URL", () => {
    const config = loadConfig(
      { NITPICK_YOUTRACK_URL: "youtrack.example.com/" },
      noFile
    )

    expect(config.youTrackURL).toBe("https://youtrack.example.com")
    expect(loadConfig({}, noFile).youTrackURL).toBeUndefined()
  })

  test("a YouTrack URL that would send tokens in cleartext is refused", () => {
    expect(() =>
      loadConfig(
        { NITPICK_YOUTRACK_URL: "http://youtrack.example.com" },
        noFile
      )
    ).toThrow(/is not secure/)
  })

  test("nitpick's service in YouTrack's Hub: a client ID, with a secret for a confidential client, or none for token sign-in", () => {
    const hub = (environment: Record<string, string>) =>
      loadConfig(environment, noFile).hubClient

    expect(hub({})).toBeUndefined()
    expect(hub({ NITPICK_YOUTRACK_CLIENT_ID: "nitpick-id" })).toEqual({
      clientID: "nitpick-id",
    })
    expect(
      hub({
        NITPICK_YOUTRACK_CLIENT_ID: "nitpick-id",
        NITPICK_YOUTRACK_CLIENT_SECRET: "fictional-secret",
      })
    ).toEqual({ clientID: "nitpick-id", clientSecret: "fictional-secret" })
    expect(() =>
      hub({ NITPICK_YOUTRACK_CLIENT_SECRET: "fictional-secret" })
    ).toThrow(/NITPICK_YOUTRACK_CLIENT_SECRET needs NITPICK_YOUTRACK_CLIENT_ID/)
  })

  test("the cap on booted devices is a whole number from 1, and no cap when unset", () => {
    expect(
      loadConfig({ NITPICK_MAX_BOOTED_DEVICES: "1" }, noFile).maxBootedDevices
    ).toBe(1)
    expect(loadConfig({}, noFile).maxBootedDevices).toBeUndefined()
    for (const cap of ["0", "1.5", "two", "-1"]) {
      expect(() =>
        loadConfig({ NITPICK_MAX_BOOTED_DEVICES: cap }, noFile)
      ).toThrow(
        `NITPICK_MAX_BOOTED_DEVICES must be a whole number from 1, not "${cap}".`
      )
    }
  })

  test.each(["NITPICK_YOUTRACK_TOKEN", "NITPICK_ACCESS_TOKEN"])(
    "the retired %s is refused, so no token sits in the config for nothing",
    (key) => {
      expect(() =>
        loadConfig({ [key]: "fictional-token-for-tests" }, noFile)
      ).toThrow(
        `${key} is no longer read: Reviewers sign in with their own YouTrack token. Remove it from the config.`
      )
    }
  )
})
