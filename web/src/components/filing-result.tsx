import type { HistoryEntry } from "@nitpick/core"
import { CheckIcon } from "lucide-react"
import { HistoryRow } from "@/components/history-row"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"

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
  onOpenHistory,
}: {
  readonly entry: HistoryEntry
  readonly disabled: boolean
  readonly onDone: () => void
  readonly onOpenHistory: () => void
}) {
  const count = entry.findings.length
  return (
    <section
      aria-label="Filing result"
      className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-5 px-8"
    >
      <div className="flex animate-in items-start gap-3 duration-300 fade-in slide-in-from-top-1 motion-reduce:animate-none">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-green/15 text-green ring-1 ring-green/30">
          <CheckIcon className="size-5" />
        </span>
        <div>
          <h1 className="text-[18px] font-semibold tracking-[-0.01em]">
            Filed {count === 1 ? "1 Issue" : `${count} Issues`} to{" "}
            {entry.project.name}
          </h1>
          <p className="text-[13px] text-text-2">
            Under your YouTrack account. History keeps the session.
          </p>
        </div>
      </div>
      <div className="animate-in rounded-[14px] p-4 studio-card duration-300 fade-in slide-in-from-top-1 motion-reduce:animate-none">
        <HistoryRow entry={entry} />
      </div>
      <div className="flex items-center gap-2">
        {/* Return presses Done, as its default-action role did. */}
        <Button autoFocus disabled={disabled} onClick={onDone}>
          Done
          <Kbd className="bg-black/10 text-primary-foreground/60">⏎</Kbd>
        </Button>
        <Button variant="outline" onClick={onOpenHistory}>
          Open History
        </Button>
        <span className="ml-auto text-[12px] text-text-3">
          The Build stays loaded for the next review.
        </span>
      </div>
    </section>
  )
}
