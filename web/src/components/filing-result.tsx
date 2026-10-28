import type { HistoryEntry } from "@nitpick/core"
import { HistoryRow } from "@/components/history-row"
import { Button } from "@/components/ui/button"

/**
 * The filing result in place, after Sources/Nitpick/FilingResultView.swift:
 * the session just filed, as its History row, until Done or the next Build
 * (ADR-0007). The server picked it by identity, so another Reviewer's later
 * session never takes its place. Nothing here can change a filed Finding.
 */
export function FilingResult({
  entry,
  disabled,
  onDone,
}: {
  readonly entry: HistoryEntry
  readonly disabled: boolean
  readonly onDone: () => void
}) {
  return (
    <section
      aria-label="Filing result"
      className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-4"
    >
      <div className="animate-in rounded-xl border p-4 duration-300 fade-in slide-in-from-top-1 motion-reduce:animate-none">
        <HistoryRow entry={entry} />
      </div>
      <div className="flex justify-end">
        {/* Return presses Done, as its default-action role did. */}
        <Button autoFocus disabled={disabled} onClick={onDone}>
          Done
        </Button>
      </div>
    </section>
  )
}
