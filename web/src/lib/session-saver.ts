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

  /** A Finding the server discarded takes its pending edits with it. */
  forget(itemID: string): void {
    this.#dirty.delete(itemID)
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
    clearTimeout(this.#timer)
    this.#timer = setTimeout(
      () => void this.flush(),
      Math.max(0, due - performance.now())
    )
  }

  async #send(work: Map<string, Set<string>>): Promise<void> {
    let failure: string | undefined
    for (const [key, fields] of work) {
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
      } catch (error) {
        // A Finding discarded meanwhile, or by another tab, takes its
        // edits with it.
        if (error instanceof APIError && error.status === 404) continue
        failure = error instanceof Error ? error.message : String(error)
        this.#requeue(key, fields)
      }
    }
    if (failure === undefined) {
      this.#typingSave = this.#typingSave.saved()
      this.#report(undefined)
      return
    }
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
