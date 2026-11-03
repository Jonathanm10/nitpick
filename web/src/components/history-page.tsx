import { ArrowLeftIcon, HistoryIcon } from "lucide-react"
import { HistoryImportButton } from "@/components/history-import"
import { HistoryRow } from "@/components/history-row"
import { Button } from "@/components/ui/button"
import type { useReview } from "@/lib/use-review"

type Review = ReturnType<typeof useReview>

/**
 * The Reviewer's History, after Sources/Nitpick/HistoryWindow.swift: the
 * Review Sessions they filed, newest first, each entry fading in a
 * beat after the one above. A page now, not a window, on the rail: ⌘Y
 * opens the browser's own History. Import History brings in what the Swift
 * app filed.
 */
export function HistoryPage({
  history,
  backLabel,
  onBack,
  onImported,
}: {
  readonly history: Review["history"]
  /** Where Back goes: the open review, or home. */
  readonly backLabel: string
  readonly onBack: () => void
  /** Called once an import added entries, to read History again. */
  readonly onImported: () => void
}) {
  const count =
    history.status === "loaded"
      ? history.entries.reduce((sum, entry) => sum + entry.findings.length, 0)
      : 0
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-panel/60 px-4">
        <Button
          variant="ghost"
          size="sm"
          className="text-text-2"
          onClick={onBack}
        >
          <ArrowLeftIcon />
          {backLabel}
        </Button>
        <span className="h-4 w-px bg-line-strong" />
        <h1 className="text-[13.5px] font-medium">History</h1>
        <span className="text-[12.5px] text-text-3">
          The Review Sessions you filed
        </span>
        <span className="flex-1" />
        {history.status === "loaded" && history.entries.length > 0 && (
          <span className="font-mono text-[11.5px] text-text-3">
            {history.entries.length}{" "}
            {history.entries.length === 1 ? "session" : "sessions"} · {count}{" "}
            {count === 1 ? "Issue" : "Issues"}
          </span>
        )}
        <HistoryImportButton onImported={onImported} />
      </header>
      <div className="min-h-0 flex-1 thin-scroll overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-8 py-8">
          {history.status === "loading" ? null : history.status === "failed" ? (
            <p role="alert" className="text-[13px] text-red select-text">
              {history.error}
            </p>
          ) : history.entries.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-24 text-center">
              <HistoryIcon className="size-7 text-text-3" aria-hidden />
              <p className="text-[14px] font-medium">No History yet</p>
              <p className="text-[13px] text-text-2">
                Filed Review Sessions appear here after they are filed.
              </p>
            </div>
          ) : (
            <ol className="flex flex-col gap-3">
              {history.entries.map((entry, index) => (
                <li
                  key={`${entry.startedAt}-${entry.filedBy?.login ?? ""}`}
                  className="animate-in rounded-[14px] p-4 studio-card duration-300 fill-mode-backwards fade-in slide-in-from-top-1 motion-reduce:animate-none"
                  // Staggered, but capped so a long History never crawls in.
                  style={{ animationDelay: `${Math.min(index * 40, 400)}ms` }}
                >
                  <HistoryRow entry={entry} />
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  )
}
