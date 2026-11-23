import type { ReactNode } from "react"
import type { BuildSummary, LibraryBuild } from "@nitpick/server/api"
import { CheckIcon, PackageIcon, Trash2Icon } from "lucide-react"
import { cn } from "cn"
import { PlatformTag } from "@/components/studio"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import type { Loadable } from "@/lib/use-review"

const uploadedAtFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
})

/** "2.1.0 (421)" */
export function versionLabel(build: BuildSummary): string {
  return `${build.identity.version} (${build.identity.buildNumber})`
}

/**
 * The Build Library (ADR-0016), newest upload first, the Reviewer's Build
 * checked, as Home's Build card and ⌘K's Choose Build from Library… show
 * it. A row picks its Build. With `onDelete`, a row's delete control asks
 * for its Build to go, and is off while the Build is in a review.
 */
export function BuildLibraryList({
  library,
  picked,
  disabled,
  empty,
  onPick,
  onDelete,
  onRetry,
}: {
  readonly library: Loadable<{ readonly builds: ReadonlyArray<LibraryBuild> }>
  /** The Reviewer's Build's id. */
  readonly picked: string | undefined
  readonly disabled: boolean
  /** What shows while the Library holds no Build. */
  readonly empty: ReactNode
  readonly onPick: (id: string) => void
  readonly onDelete?: (build: LibraryBuild) => void
  readonly onRetry: () => void
}) {
  if (library.status === "loading") {
    return (
      <div className="flex min-h-24 flex-1 items-center justify-center">
        <Spinner
          aria-label="Loading the Build Library"
          className="text-text-3"
        />
      </div>
    )
  }
  if (library.status === "failed") {
    return (
      <div className="flex min-h-24 flex-1 flex-col items-center justify-center gap-2 text-center">
        <p className="max-w-72 text-[12.5px] text-text-2 select-text">
          {library.error}
        </p>
        <Button variant="ghost" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    )
  }
  if (library.builds.length === 0) return empty
  return (
    <ul
      aria-label="Builds on the Device Host"
      className="-mx-1 flex max-h-[280px] min-h-0 thin-scroll flex-col gap-1 overflow-y-auto px-1 leading-normal"
    >
      {library.builds.map((listed) => {
        const isPicked = listed.id === picked
        return (
          <li
            key={listed.id}
            className={cn(
              "group/row flex items-center gap-1 rounded-[9px] pr-1.5",
              isPicked
                ? "bg-white/[0.07] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]"
                : "hover:bg-white/[0.035]"
            )}
          >
            <button
              type="button"
              aria-current={isPicked ? "true" : undefined}
              disabled={disabled}
              onClick={() => onPick(listed.id)}
              className="flex min-w-0 flex-1 items-center gap-3 rounded-[8px] p-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-[9px] bg-white/[0.06] ring-1 ring-white/10">
                {isPicked ? (
                  <CheckIcon className="size-4 text-green" aria-hidden />
                ) : (
                  <PackageIcon className="size-4 text-text-2" aria-hidden />
                )}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 items-baseline gap-2">
                  <span
                    className={cn(
                      "truncate text-[13.5px]",
                      isPicked && "font-medium"
                    )}
                  >
                    {listed.name}
                  </span>
                  <span className="shrink-0 font-mono text-[11.5px] text-text-2">
                    {versionLabel(listed)}
                  </span>
                </span>
                <span className="truncate text-[11.5px] text-text-3">
                  {listed.uploadedBy.name} ·{" "}
                  <time dateTime={listed.uploadedAt}>
                    {uploadedAtFormat.format(new Date(listed.uploadedAt))}
                  </time>
                </span>
              </span>
              <PlatformTag
                device={{
                  platform:
                    listed.platform === "android" ? "android" : undefined,
                }}
              />
            </button>
            {listed.inUse && (
              <span className="shrink-0 rounded-full px-2 py-0.5 text-[11px] text-amber ring-1 ring-amber/25">
                In a review
              </span>
            )}
            {onDelete !== undefined && (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Delete ${listed.name} ${versionLabel(listed)}`}
                title={
                  listed.inUse
                    ? "In a review, so it can't be deleted"
                    : "Delete Build"
                }
                disabled={disabled || listed.inUse}
                onClick={() => onDelete(listed)}
                className={cn(
                  "rounded-full text-text-3",
                  !isPicked &&
                    "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
                )}
              >
                <Trash2Icon />
              </Button>
            )}
          </li>
        )
      })}
    </ul>
  )
}
