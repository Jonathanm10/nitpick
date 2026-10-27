import type { EditorState } from "./editorState.ts"
import type { ReviewSession } from "./reviewSession.ts"

/** A step through the Tray, as Next and Previous Finding take it. */
export type TrayStep = "next" | "previous"

/**
 * The Tray item one step from `current` in display order, newest first: Next
 * is the row below, Previous the row above. Filed and mid-ladder rows count.
 * Past either end there is nothing, rather than a wrap. With no current row,
 * or one no longer in the Tray, Next enters at the newest row and Previous at
 * the oldest.
 */
export function stepInTray(
  session: Pick<ReviewSession, "tray">,
  step: TrayStep,
  current?: string
): string | undefined {
  const displayed = session.tray.map((item) => item.id).reverse()
  const index = current === undefined ? -1 : displayed.indexOf(current)
  if (index === -1) return step === "next" ? displayed[0] : displayed.at(-1)
  return displayed[step === "next" ? index + 1 : index - 1]
}

/**
 * The Editor after Next or Previous Finding, or undefined when the step has
 * nowhere to go or the selection is refused.
 */
export function stepEditor(
  editor: EditorState,
  step: TrayStep,
  session: Pick<ReviewSession, "tray"> | undefined
): EditorState | undefined {
  if (session === undefined) return undefined
  const target = stepInTray(session, step, editor.target)
  return target === undefined ? undefined : editor.selecting(target, session)
}
