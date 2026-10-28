import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { parseEnv } from "node:util"
import { normalizedInstanceURL } from "@nitpick/core"
import type { HubClient } from "./youTrackHub.ts"

export interface ServerConfig {
  /** The address to listen on. Loopback by default: the host opts in to the LAN. */
  readonly host: string
  readonly port: number
  /** Where the server keeps its data, from Review Session storage on. */
  readonly dataDirectory: string
  /**
   * The one YouTrack instance every Reviewer signs in to and files into
   * (PRD answer 1), cleaned up as the Swift app cleaned an entered URL.
   * Undefined when unset; the server then refuses to start.
   */
  readonly youTrackURL: string | undefined
  /**
   * nitpick as a service registered in that instance's Hub, so Reviewers
   * sign in through YouTrack's login; undefined for permanent tokens.
   */
  readonly hubClient: HubClient | undefined
  /**
   * At most this many devices booted at once (PRD answer 4), so the host's
   * memory holds; undefined for no cap.
   */
  readonly maxBootedDevices: number | undefined
  /**
   * The PEM certificate and private key the server serves HTTPS with, both
   * set or both unset; unset serves plain HTTP.
   */
  readonly tlsCertificateFile: string | undefined
  readonly tlsKeyFile: string | undefined
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

  const tlsCertificateFile = value("NITPICK_TLS_CERT")
  const tlsKeyFile = value("NITPICK_TLS_KEY")
  if ((tlsCertificateFile === undefined) !== (tlsKeyFile === undefined)) {
    throw new Error(
      "Set both NITPICK_TLS_CERT and NITPICK_TLS_KEY to serve HTTPS, or neither."
    )
  }

  return {
    host: value("NITPICK_HOST") ?? "127.0.0.1",
    port: parsePort(value("NITPICK_PORT")),
    dataDirectory: resolve(
      value("NITPICK_DATA_DIR") ??
        join(homedir(), "Library", "Application Support", "nitpick-server")
    ),
    youTrackURL: youTrackURL(value),
    hubClient: hubClient(value),
    maxBootedDevices: parseDeviceCap(value("NITPICK_MAX_BOOTED_DEVICES")),
    tlsCertificateFile,
    tlsKeyFile,
  }
}

/** The interim tokens issues 06 and 09 read, before Reviewers signed in. */
const retiredKeys = ["NITPICK_YOUTRACK_TOKEN", "NITPICK_ACCESS_TOKEN"]

function youTrackURL(
  value: (key: string) => string | undefined
): string | undefined {
  // A token left in the config would sit on the host for nothing.
  for (const key of retiredKeys) {
    if (value(key) !== undefined) {
      throw new Error(
        `${key} is no longer read: Reviewers sign in with their own YouTrack token. Remove it from the config.`
      )
    }
  }
  const url = value("NITPICK_YOUTRACK_URL")
  return url === undefined ? undefined : normalizedInstanceURL(url)
}

function hubClient(
  value: (key: string) => string | undefined
): HubClient | undefined {
  const clientID = value("NITPICK_YOUTRACK_CLIENT_ID")
  const clientSecret = value("NITPICK_YOUTRACK_CLIENT_SECRET")
  if (clientID === undefined) {
    if (clientSecret !== undefined) {
      throw new Error(
        "NITPICK_YOUTRACK_CLIENT_SECRET needs NITPICK_YOUTRACK_CLIENT_ID, the client ID of nitpick's service in YouTrack's Hub."
      )
    }
    return undefined
  }
  return clientSecret === undefined ? { clientID } : { clientID, clientSecret }
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

function parseDeviceCap(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const cap = Number(value)
  if (!/^[0-9]+$/.test(value) || cap < 1) {
    throw new Error(
      `NITPICK_MAX_BOOTED_DEVICES must be a whole number from 1, not "${value}".`
    )
  }
  return cap
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === "" ? undefined : trimmed
}
