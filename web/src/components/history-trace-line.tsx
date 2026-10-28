import type { HistoryTrace } from "@nitpick/core"
import { formatSessionStart } from "@/components/history-row"

/**
 * The home page's foot, after HistoryTraceLine in
 * Sources/Nitpick/HistoryWindow.swift: the signed-in Reviewer's last filed
 * session and up to three of its Issues, "+N" for the rest. Everything but
 * an Issue link opens the History page. Only the Reviewer's own session:
 * History is shared.
 */
export function HistoryTraceLine({
  trace,
  onOpenHistory,
}: {
  readonly trace: HistoryTrace
  readonly onOpenHistory: () => void
}) {
  const { build, startedAt } = trace.latestEntry
  return (
    <nav
      aria-label="Your last filed session"
      className="flex items-center gap-3 text-sm text-muted-foreground"
    >
      <button
        type="button"
        onClick={onOpenHistory}
        className="min-w-0 flex-1 truncate text-left underline-offset-4 hover:underline"
      >
        {build.bundleID} {build.version} ({build.buildNumber}) ·{" "}
        {formatSessionStart(startedAt)}
      </button>
      {trace.visibleIssues.map((issue) => (
        <a
          key={issue.idReadable}
          href={issue.url}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 underline-offset-4 hover:text-foreground hover:underline"
        >
          {issue.idReadable}
        </a>
      ))}
      {trace.overflowCount > 0 && (
        <button
          type="button"
          onClick={onOpenHistory}
          className="shrink-0 underline-offset-4 hover:text-foreground hover:underline"
        >
          +{trace.overflowCount}
        </button>
      )}
    </nav>
  )
}
