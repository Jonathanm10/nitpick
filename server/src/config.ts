import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { parseEnv } from "node:util"
import { YouTrackCredentials } from "@nitpick/core"

export interface ServerConfig {
  /**
   * The address to listen on. Loopback by default: until login exists, the
   * host has to opt in before anything on the LAN can reach the server.
   */
  readonly host: string
  readonly port: number
  /** Where the server keeps its data, from Review Session storage on. */
  readonly dataDirectory: string
  /**
   * The one YouTrack instance and token the server reads projects and files
   * with until sign-in exists (issue 10). Undefined when neither key is set.
   * The token sits in the credentials' private field, so logging the config
   * never prints it.
   */
  readonly youTrack: YouTrackCredentials | undefined
}

export const defaultPort = 4870

type Environment = Readonly<Record<string, string | undefined>>

/**
 * Reads the config from the environment, or from the dotenv-style file that
 * `NITPICK_CONFIG_FILE` names, which lives outside the repo. The environment
 * wins over the file. An empty value counts as unset, so an unedited copy of
 * `config.example.env` changes nothing.
 */
export function loadConfig(
  environment: Environment,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8")
): ServerConfig {
  const configFile = nonEmpty(environment.NITPICK_CONFIG_FILE)
  const fromFile =
    configFile === undefined ? {} : parseEnv(readFile(configFile))
  const value = (key: string) =>
    nonEmpty(environment[key]) ?? nonEmpty(fromFile[key])

  return {
    host: value("NITPICK_HOST") ?? "127.0.0.1",
    port: parsePort(value("NITPICK_PORT")),
    dataDirectory: resolve(
      value("NITPICK_DATA_DIR") ??
        join(homedir(), "Library", "Application Support", "nitpick-server")
    ),
    youTrack: youTrackCredentials(
      value("NITPICK_YOUTRACK_URL"),
      value("NITPICK_YOUTRACK_TOKEN")
    ),
  }
}

function youTrackCredentials(
  url: string | undefined,
  token: string | undefined
): YouTrackCredentials | undefined {
  if (url === undefined && token === undefined) return undefined
  if (url === undefined || token === undefined) {
    throw new Error(
      "NITPICK_YOUTRACK_URL and NITPICK_YOUTRACK_TOKEN must be set together."
    )
  }
  return new YouTrackCredentials(url, token)
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return defaultPort
  const port = Number(value)
  if (!/^[0-9]+$/.test(value) || port < 1 || port > 65535) {
    throw new Error(
      `NITPICK_PORT must be a port number from 1 to 65535, not "${value}".`
    )
  }
  return port
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === "" ? undefined : trimmed
}
