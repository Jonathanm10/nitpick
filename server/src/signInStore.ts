// Who is signed in, and the YouTrack token each sign-in files with (PRD
// answer 1). A sign-in's ID is a random secret that only the browser's
// cookie holds. The server keeps the ID's SHA-256, so neither its files nor a
// backup of them can sign anyone in, and keeps the token encrypted with
// AES-256-GCM under a key file in the data directory, so filing can resume
// after a restart or the scheduled reboot. Signing out deletes both.
//
//   <data>/sign-in-key                        32 random bytes, mode 0600
//   <data>/sign-ins/<SHA-256 of the ID>.json  one per sign-in, mode 0600
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto"
import {
  link,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { dirname, join } from "node:path"
import { newUUID, YouTrackCredentials, type YouTrackUser } from "@nitpick/core"
import { writeAtomically } from "./reviewerStore.ts"

/** A month without a request ends a sign-in (PRD answer 1). */
export const signInLifetime = 30 * 24 * 60 * 60 * 1000

/** A sign-in in use moves its end at most daily, so requests seldom write. */
const renewalInterval = 24 * 60 * 60 * 1000

/** How many ended sign-ins remember why, for the pages still holding them. */
const rememberedEndings = 1000

/** 32 random bytes, base64url. */
const idPattern = /^[A-Za-z0-9_-]{43}$/

export interface SignIn {
  /** The SHA-256 of the ID, in hex: all the server keeps of the ID. */
  readonly key: string
  readonly user: YouTrackUser
  /** The token sits in the credentials' private field. */
  readonly credentials: YouTrackCredentials
  /** Milliseconds since 1970. */
  readonly expiresAt: number
}

/** A sign-in's file. */
interface StoredSignIn {
  readonly instanceURL: string
  readonly login: string
  readonly fullName: string
  /** The token, sealed: base64url of the IV, the ciphertext and the tag. */
  readonly token: string
  readonly expiresAt: number
}

export class SignInStore {
  readonly #directory: string
  readonly #keyPath: string
  readonly #instanceURL: string
  readonly #now: () => number
  #key: Promise<Buffer> | undefined
  readonly #signIns = new Map<
    string,
    { signIn: SignIn; stored: StoredSignIn }
  >()
  readonly #endings = new Map<string, string>()
  /**
   * File writes and deletions run in turn, so a renewal still writing can't
   * bring back the file of a sign-in that ended meanwhile.
   */
  #writes: Promise<unknown> = Promise.resolve()

  constructor(
    dataDirectory: string,
    /** The deployment's one instance; a sign-in for another one is dropped. */
    instanceURL: string,
    now: () => number = Date.now
  ) {
    this.#directory = join(dataDirectory, "sign-ins")
    this.#keyPath = join(dataDirectory, "sign-in-key")
    this.#instanceURL = instanceURL
    this.#now = now
  }

  /**
   * Reads the sign-ins the last run left. One that expired, names another
   * instance, or no longer opens with the key file is deleted.
   */
  async load(): Promise<void> {
    const key = await this.#cipherKey()
    const names = await readdir(this.#directory).catch(() => [])
    for (const name of names) {
      const match = /^([0-9a-f]{64})\.json$/.exec(name)
      if (match === null) continue
      const path = join(this.#directory, name)
      const loaded = await readFile(path, "utf8")
        .then((json) => this.#opened(match[1]!, JSON.parse(json), key))
        .catch(() => undefined)
      if (loaded === undefined) await rm(path, { force: true })
      else this.#signIns.set(loaded.signIn.key, loaded)
    }
  }

  /** Starts a sign-in for a verified user; the ID goes in their cookie. */
  async create(
    user: YouTrackUser,
    token: string
  ): Promise<{ readonly id: string; readonly signIn: SignIn }> {
    const id = randomBytes(32).toString("base64url")
    const key = keyOf(id)
    const stored: StoredSignIn = {
      instanceURL: this.#instanceURL,
      login: user.login,
      fullName: user.fullName,
      token: seal(await this.#cipherKey(), token, additionalData(key, user)),
      expiresAt: this.#now() + signInLifetime,
    }
    await this.#queued(() => this.#write(key, stored))
    const signIn: SignIn = {
      key,
      user,
      credentials: new YouTrackCredentials(this.#instanceURL, token),
      expiresAt: stored.expiresAt,
    }
    this.#signIns.set(key, { signIn, stored })
    return { id, signIn }
  }

  /**
   * The live sign-in an ID names. Looked up by the ID's SHA-256, never
   * compared, so the time a lookup takes says nothing about stored IDs.
   */
  find(id: string): SignIn | undefined {
    if (!idPattern.test(id)) return undefined
    const entry = this.#signIns.get(keyOf(id))
    if (entry === undefined) return undefined
    if (entry.signIn.expiresAt <= this.#now()) {
      void this.end(entry.signIn).catch(() => {})
      return undefined
    }
    return entry.signIn
  }

  /** Why the sign-in an ID named ended, when it ended with a reason. */
  endingOf(id: string): string | undefined {
    return idPattern.test(id) ? this.#endings.get(keyOf(id)) : undefined
  }

  /**
   * Moves a sign-in's end a month out once a day has passed since the last
   * move: the sliding expiry. Answers whether it moved, so the cookie's can.
   */
  async renew(signIn: SignIn): Promise<boolean> {
    const entry = this.#signIns.get(signIn.key)
    const now = this.#now()
    if (
      entry === undefined ||
      entry.signIn.expiresAt - now > signInLifetime - renewalInterval
    ) {
      return false
    }
    const expiresAt = now + signInLifetime
    entry.signIn = { ...entry.signIn, expiresAt }
    entry.stored = { ...entry.stored, expiresAt }
    const stored = entry.stored
    await this.#queued(async () => {
      if (this.#signIns.has(signIn.key)) await this.#write(signIn.key, stored)
    })
    return true
  }

  /** Ends a sign-in: its file, with the token, is deleted. */
  async end(signIn: SignIn, reason?: string): Promise<void> {
    this.#signIns.delete(signIn.key)
    if (reason !== undefined) {
      this.#endings.set(signIn.key, reason)
      if (this.#endings.size > rememberedEndings) {
        this.#endings.delete(this.#endings.keys().next().value!)
      }
    }
    await this.#queued(() =>
      rm(this.#path(signIn.key), { force: true }).then(() => {})
    )
  }

  /** Every live sign-in, the latest used first. */
  all(): SignIn[] {
    const now = this.#now()
    return [...this.#signIns.values()]
      .map((entry) => entry.signIn)
      .filter((signIn) => signIn.expiresAt > now)
      .sort((a, b) => b.expiresAt - a.expiresAt)
  }

  #opened(
    key: string,
    json: unknown,
    cipherKey: Buffer
  ): { signIn: SignIn; stored: StoredSignIn } | undefined {
    const stored = json as StoredSignIn
    if (
      typeof stored !== "object" ||
      stored === null ||
      stored.instanceURL !== this.#instanceURL ||
      typeof stored.login !== "string" ||
      typeof stored.fullName !== "string" ||
      typeof stored.token !== "string" ||
      typeof stored.expiresAt !== "number" ||
      stored.expiresAt <= this.#now()
    ) {
      return undefined
    }
    const user = { login: stored.login, fullName: stored.fullName }
    const token = unseal(cipherKey, stored.token, additionalData(key, user))
    return {
      signIn: {
        key,
        user,
        credentials: new YouTrackCredentials(this.#instanceURL, token),
        expiresAt: stored.expiresAt,
      },
      stored,
    }
  }

  async #write(key: string, stored: StoredSignIn): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 })
    await writeAtomically(this.#path(key), JSON.stringify(stored), 0o600)
  }

  #path(key: string): string {
    return join(this.#directory, `${key}.json`)
  }

  #queued<T>(write: () => Promise<T>): Promise<T> {
    const result = this.#writes.then(write)
    this.#writes = result.catch(() => {})
    return result
  }

  #cipherKey(): Promise<Buffer> {
    this.#key ??= cipherKey(this.#keyPath)
    return this.#key
  }
}

function keyOf(id: string): string {
  return createHash("sha256").update(id).digest("hex")
}

/** Binds a sealed token to its sign-in, so it opens in no other file. */
function additionalData(key: string, user: YouTrackUser): Buffer {
  return Buffer.from(JSON.stringify([key, user.login]))
}

/**
 * The key file, created on first use with mode 0600. It's written aside and
 * linked into place, so it never exists half written, and a second server
 * creating it at once reads the first one's. Like ssh with a private key, a
 * key file others can read is refused rather than used.
 */
async function cipherKey(path: string): Promise<Buffer> {
  await mkdir(dirname(path), { recursive: true })
  const created = randomBytes(32)
  const temporary = `${path}.${newUUID()}.tmp`
  await writeFile(temporary, created, { mode: 0o600 })
  try {
    await link(temporary, path)
    return created
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  } finally {
    await rm(temporary, { force: true })
  }
  if (((await stat(path)).mode & 0o077) !== 0) {
    throw new Error(
      `${path} can be read by other users of the Device Host. Run chmod 600 on it.`
    )
  }
  const key = await readFile(path)
  if (key.length !== 32) {
    throw new Error(`${path} isn't a 32-byte nitpick sign-in key.`)
  }
  return key
}

const ivLength = 12
const tagLength = 16

function seal(key: Buffer, text: string, additional: Buffer): string {
  const iv = randomBytes(ivLength)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  cipher.setAAD(additional)
  const ciphertext = Buffer.concat([
    cipher.update(text, "utf8"),
    cipher.final(),
  ])
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString(
    "base64url"
  )
}

/** Throws unless the sealed text opens with this key, untampered. */
function unseal(key: Buffer, sealed: string, additional: Buffer): string {
  const bytes = Buffer.from(sealed, "base64url")
  if (bytes.length < ivLength + tagLength) {
    throw new Error("A sealed token is too short.")
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    bytes.subarray(0, ivLength)
  )
  decipher.setAAD(additional)
  decipher.setAuthTag(bytes.subarray(bytes.length - tagLength))
  return Buffer.concat([
    decipher.update(bytes.subarray(ivLength, bytes.length - tagLength)),
    decipher.final(),
  ]).toString("utf8")
}
