import {
  dateFromReference,
  trimWhitespaceAndNewlines,
  type HistoryEntry,
  type ReferenceDate,
} from "@nitpick/core"

const sessionStartFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
})

/** When a session started, as Swift's abbreviated date and short time. */
export function formatSessionStart(startedAt: ReferenceDate): string {
  return sessionStartFormat.format(dateFromReference(startedAt))
}

/**
 * One History entry, read-only, after Sources/Nitpick/HistoryRow.swift: the
 * project, the Build and when the session started, who filed it, then each
 * filed Finding's Issue link and summary. No screenshots, no YouTrack reads.
 * The History page and the filing result both show it, so they stay alike
 * (ADR-0007).
 */
export function HistoryRow({ entry }: { readonly entry: HistoryEntry }) {
  const { build } = entry
  return (
    <article className="flex min-w-0 flex-col gap-1">
      <header className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="font-medium">{entry.project.name}</span>
        <span className="font-mono text-xs text-muted-foreground">
          {build.bundleID} {build.version} ({build.buildNumber})
        </span>
        <time
          dateTime={dateFromReference(entry.startedAt).toISOString()}
          className="text-muted-foreground"
        >
          {formatSessionStart(entry.startedAt)}
        </time>
      </header>
      <ul className="flex flex-col gap-0.5">
        {entry.findings.map((finding) => {
          const summary = trimWhitespaceAndNewlines(finding.summary)
          return (
            <li
              key={finding.issue.idReadable}
              className="flex min-w-0 items-baseline gap-2 text-sm"
            >
              <a
                href={finding.issue.url}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 font-medium text-primary underline-offset-4 hover:underline"
              >
                {finding.issue.idReadable}
              </a>
              <span className="truncate text-muted-foreground">
                {summary === "" ? "Untitled Finding" : summary}
              </span>
            </li>
          )
        })}
      </ul>
    </article>
  )
}
