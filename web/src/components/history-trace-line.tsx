import type { HistoryTrace } from "@nitpick/core"
import { ArrowRightIcon, HistoryIcon } from "lucide-react"
import { formatSessionStart } from "@/components/history-row"
import { ProjectKey } from "@/components/studio"

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
      className="flex h-11 items-center gap-3 rounded-[12px] px-4 text-[12.5px] text-text-2 studio-card"
    >
      <HistoryIcon className="size-3.5 shrink-0 text-text-3" aria-hidden />
      <span className="shrink-0 text-text-3">Your last filed session</span>
      <ProjectKey project={trace.latestEntry.project} />
      <button
        type="button"
        onClick={onOpenHistory}
        className="min-w-0 flex-1 truncate text-left underline-offset-4 hover:text-foreground hover:underline"
      >
        <span className="font-mono">
          {build.bundleID} {build.version} ({build.buildNumber})
        </span>{" "}
        · {formatSessionStart(startedAt)}
      </button>
      {trace.visibleIssues.map((issue) => (
        <a
          key={issue.idReadable}
          href={issue.url}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 font-mono text-[12px] text-foreground underline-offset-4 hover:underline"
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
      <button
        type="button"
        onClick={onOpenHistory}
        className="flex shrink-0 items-center gap-1 text-text-3 hover:text-foreground"
      >
        History <ArrowRightIcon className="size-3.5" />
      </button>
    </nav>
  )
}
