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
})
