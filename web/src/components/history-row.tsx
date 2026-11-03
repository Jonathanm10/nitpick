import {
  dateFromReference,
  trimWhitespaceAndNewlines,
  type HistoryEntry,
  type ReferenceDate,
} from "@nitpick/core"
import { ArrowUpRightIcon } from "lucide-react"
import { Avatar, ProjectKey } from "@/components/studio"

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
    <article className="flex min-w-0 flex-col gap-3">
      <header className="flex min-w-0 items-center gap-2.5">
        {entry.filedBy !== undefined && (
          <Avatar user={entry.filedBy} size={24} />
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-2 text-[13px]">
            <ProjectKey project={entry.project} />
            <span className="truncate font-medium">{entry.project.name}</span>
            {entry.filedBy !== undefined && (
              <span className="truncate text-text-3">
                filed by {entry.filedBy.fullName}
              </span>
            )}
          </span>
          <span className="truncate font-mono text-[11.5px] text-text-2 select-text">
            {build.bundleID} {build.version} ({build.buildNumber})
          </span>
        </div>
        <time
          dateTime={dateFromReference(entry.startedAt).toISOString()}
          className="shrink-0 font-mono text-[11.5px] text-text-3"
        >
          {formatSessionStart(entry.startedAt)}
        </time>
      </header>
      <ul className="flex flex-col">
        {entry.findings.map((finding) => {
          const summary = trimWhitespaceAndNewlines(finding.summary)
          return (
            <li
              key={finding.issue.idReadable}
              className="flex h-8 min-w-0 items-center gap-3 border-t border-line text-[13px]"
            >
              <a
                href={finding.issue.url}
                target="_blank"
                rel="noreferrer"
                className="flex w-20 shrink-0 items-center gap-1 font-mono text-[12px] text-foreground underline-offset-4 hover:underline"
              >
                {finding.issue.idReadable}
                <ArrowUpRightIcon className="size-3 text-text-3" />
              </a>
              <span className="truncate text-text-2">
                {summary === "" ? "Untitled Finding" : summary}
              </span>
            </li>
          )
        })}
      </ul>
    </article>
  )
}
