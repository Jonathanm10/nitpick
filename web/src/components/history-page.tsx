import { ArrowLeftIcon, HistoryIcon } from "lucide-react"
import { HistoryImportButton } from "@/components/history-import"
import { HistoryRow } from "@/components/history-row"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import type { useReview } from "@/lib/use-review"

type Review = ReturnType<typeof useReview>

/**
 * The Reviewer's History, after Sources/Nitpick/HistoryWindow.swift: the
 * Review Sessions they filed, newest first, each entry fading in a
 * beat after the one above. A page now, not a window, linked from the
 * header: ⌘Y opens the browser's own History. Import History brings in what
 * the Swift app filed.
 */
export function HistoryPage({
  history,
  onBack,
  onImported,
}: {
  readonly history: Review["history"]
  readonly onBack: () => void
  /** Called once an import added entries, to read History again. */
  readonly onImported: () => void
}) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeftIcon />
          Back
        </Button>
        <h1 className="text-lg font-medium">History</h1>
        <HistoryImportButton onImported={onImported} />
      </div>
      {history.status === "loading" ? null : history.status === "failed" ? (
        <p role="alert" className="text-sm text-destructive select-text">
          {history.error}
        </p>
      ) : history.entries.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-24 text-center">
          <HistoryIcon className="size-8 text-muted-foreground" aria-hidden />
          <p className="font-medium">No History yet</p>
          <p className="text-sm text-muted-foreground">
            Filed Review Sessions appear here after they are filed.
          </p>
        </div>
      ) : (
        <ol className="flex flex-col gap-4">
          {history.entries.map((entry, index) => (
            <li
              key={`${entry.startedAt}-${entry.filedBy?.login ?? ""}`}
              className="flex animate-in flex-col gap-4 duration-300 fill-mode-backwards fade-in slide-in-from-top-1 motion-reduce:animate-none"
              // Staggered, but capped so a long History never crawls in.
              style={{ animationDelay: `${Math.min(index * 40, 400)}ms` }}
            >
              {index > 0 && <Separator />}
              <HistoryRow entry={entry} />
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
