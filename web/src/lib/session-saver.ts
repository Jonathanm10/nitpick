// Autosave to the server, after AppModel.swift's persistOpenSession and
// TypingSave: every edit is saved, typing once it pauses. The page edits its
// own copy of the session at once; the saver sends each changed field's
// current value, so the last write wins per field. A failed save shows an
// error and retries until one succeeds.
import { TypingSave, type Finding } from "@nitpick/core"
import type {
  FindingPatch,
  SessionPatch,
  SessionSummary,
} from "@nitpick/server/api"
import { api, APIError } from "@/lib/api"

/** A Finding's field the page edits. */
export type FindingField = keyof FindingPatch & keyof Finding

/** The session's own fields live under this key; Findings under their id. */
const sessionKey = "session"

export class SessionSaver {
  #session: SessionSummary | undefined
  readonly #report: (error: string | undefined) => void
  /** Changed fields not yet sent, by Finding id or `sessionKey`. */
  #dirty = new Map<string, Set<string>>()
  #typingSave = new TypingSave()
  #timer: ReturnType<typeof setTimeout> | undefined
  #saving: Promise<void> | undefined
  #saveAgain = false
  /** Counts failed sends, so a caller can tell one happened while it waited. */
  #failures = 0
  /** Counts Findings whose edits were sent, or dropped with their Finding. */
  #settled = 0
  /**
   * Set while the page that owns it is unmounted, as on sign-out: nothing
   * goes out then, retries included, or it would go out under whoever
   * signs in next.
   */
  #stopped = false

  /** `report` gets the failure to show, or undefined once a save succeeds. */
  constructor(report: (error: string | undefined) => void) {
    this.#report = report
  }

  /**
   * The page's copy of the open session, set with every change, so a save
   * sent right after an edit carries it.
   */
  get session(): SessionSummary | undefined {
    return this.#session
  }

  track(session: SessionSummary | undefined): void {
    this.#session = session
  }

  /** A Finding's fields changed; typing waits for a pause. */
  findingEdited(
    itemID: string,
    fields: ReadonlyArray<FindingField>,
    { typing }: { readonly typing: boolean }
  ): void {
    this.#mark(itemID, fields, typing)
  }

  sessionEdited(): void {
    this.#mark(sessionKey, ["designReference"], true)
  }

  /** Sends every pending field now. */
  flush(): Promise<void> {
    clearTimeout(this.#timer)
    this.#timer = undefined
    if (this.#stopped) return Promise.resolve()
    if (this.#saving !== undefined) {
      this.#saveAgain = true
      return this.#saving
    }
    if (this.#dirty.size === 0) return Promise.resolve()
    const work = this.#dirty
    this.#dirty = new Map()
    this.#saving = this.#send(work).finally(() => {
      this.#saving = undefined
      if (this.#saveAgain) {
        this.#saveAgain = false
        void this.flush()
      }
    })
    return this.#saving
  }

  /**
   * Sends every pending edit, edits made while a save was in flight
   * included, and answers whether all reached the server. A failed save
   * stops it, and so does a pass that settles nothing: edits waiting on a
   * discard still in flight, which only its answer settles. The usual retry
   * carries on.
   */
  async saveAll(): Promise<boolean> {
    while (this.#dirty.size > 0 || this.#saving !== undefined) {
      const failures = this.#failures
      const settled = this.#settled
      await this.flush()
      if (this.#failures !== failures || this.#settled === settled) {
        return false
      }
    }
    return true
  }

  /** A Finding the server discarded takes its pending edits with it. */
  forget(itemID: string): void {
    this.#dirty.delete(itemID)
  }

  /** The page mounted: saving may go out. */
  start(): void {
    this.#stopped = false
  }

  /** The page unmounted: drop everything pending, and send nothing more. */
  stop(): void {
    this.#stopped = true
    clearTimeout(this.#timer)
    this.#timer = undefined
    this.#dirty = new Map()
  }

  /** The session ended: drop everything pending, and the error with it. */
  cancel(): void {
    clearTimeout(this.#timer)
    this.#timer = undefined
    this.#dirty = new Map()
    this.#typingSave = new TypingSave()
    this.#report(undefined)
  }

  #mark(key: string, fields: ReadonlyArray<string>, typing: boolean): void {
    const pending = this.#dirty.get(key) ?? new Set()
    for (const field of fields) pending.add(field)
    this.#dirty.set(key, pending)
    if (!typing) {
      void this.flush()
      return
    }
    const { save, due } = this.#typingSave.keystroke(performance.now())
    this.#typingSave = save
    this.#schedule(due)
  }

  #schedule(due: number): void {
    if (this.#stopped) return
    clearTimeout(this.#timer)
    this.#timer = setTimeout(
      () => void this.flush(),
      Math.max(0, due - performance.now())
    )
  }

  async #send(work: Map<string, Set<string>>): Promise<void> {
    let failure: string | undefined
    for (const [key, fields] of work) {
      if (this.#stopped) return
      // A Finding being discarded keeps its edits until the server confirms
      // the discard (`forget`), so a refused discard still saves them.
      if (
        key !== sessionKey &&
        !this.#session?.tray.some((item) => item.id === key)
      ) {
        this.#requeue(key, fields)
        continue
      }
      try {
        await this.#save(key, fields)
        this.#settled++
      } catch (error) {
        // A Finding discarded meanwhile, or by another tab, takes its
        // edits with it.
        if (error instanceof APIError && error.status === 404) {
          this.#settled++
          continue
        }
        failure = error instanceof Error ? error.message : String(error)
        this.#requeue(key, fields)
      }
    }
    if (this.#stopped) return
    if (failure === undefined) {
      this.#typingSave = this.#typingSave.saved()
      this.#report(undefined)
      return
    }
    this.#failures++
    const { save, due } = this.#typingSave.failed(performance.now())
    this.#typingSave = save
    this.#report(`Your edits aren't saved yet: ${failure} Retrying…`)
    this.#schedule(due)
  }

  #requeue(key: string, fields: Set<string>): void {
    const pending = this.#dirty.get(key) ?? new Set()
    for (const field of fields) pending.add(field)
    this.#dirty.set(key, pending)
  }

  async #save(key: string, fields: Set<string>): Promise<void> {
    const session = this.#session
    if (session === undefined) return
    if (key === sessionKey) {
      const patch: SessionPatch = {
        designReference: session.designReference ?? null,
      }
      await api.editSession(patch)
      return
    }
    const finding = session.tray.find((item) => item.id === key)?.finding
    if (finding === undefined) return
    const patch: Record<string, unknown> = {}
    for (const field of fields as Set<FindingField>) {
      patch[field] = finding[field] ?? null
    }
    await api.editFinding(key, patch as FindingPatch)
  }
}
