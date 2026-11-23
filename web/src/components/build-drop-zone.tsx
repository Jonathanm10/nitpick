import { useRef, useState } from "react"
import type { BuildSummary, LibraryBuild } from "@nitpick/server/api"
import { CheckIcon, PackageIcon, Trash2Icon, UploadIcon } from "lucide-react"
import { cn } from "cn"
import { PlatformTag, SectionLabel } from "@/components/studio"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import type { Loadable } from "@/lib/use-review"

interface BuildDropZoneProps {
  /** The Reviewer's Build, checked in the list. */
  readonly build: BuildSummary | undefined
  readonly library: Loadable<{ readonly builds: ReadonlyArray<LibraryBuild> }>
  /** The Build they picked, which someone has since deleted. */
  readonly deletedPick: BuildSummary | undefined
  /** A file is being dragged over the page, which takes the drop anywhere. */
  readonly isDragging: boolean
  readonly disabled: boolean
  readonly onChoose: (file: File) => void
  readonly onPick: (id: string) => void
  readonly onDelete: (id: string) => void
  readonly onRetry: () => void
}

const uploadedAtFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
})

/** "2.1.0 (421)" */
function versionLabel(build: BuildSummary): string {
  return `${build.identity.version} (${build.identity.buildNumber})`
}

/**
 * Home's first card: the Build Library (ADR-0016), newest upload first, the
 * Reviewer's Build checked. A row picks its Build; its delete control asks
 * first, and is off while the Build is in a review. Empty, the card asks
 * for a zipped simulator Build or an Android .apk, dropped anywhere or
 * chosen; an upload lands in the Library for everyone.
 */
export function BuildDropZone({
  build,
  library,
  deletedPick,
  isDragging,
  disabled,
  onChoose,
  onPick,
  onDelete,
  onRetry,
}: BuildDropZoneProps) {
  const input = useRef<HTMLInputElement>(null)
  const [pendingDelete, setPendingDelete] = useState<LibraryBuild>()
  const builds = library.status === "loaded" ? library.builds : []

  return (
    <section
      aria-label="Build"
      className={cn(
        "flex min-h-64 flex-col gap-4 rounded-[14px] p-4 studio-card transition-shadow",
        isDragging && "shadow-[inset_0_0_0_1.5px_rgb(255_69_58/0.6)]"
      )}
    >
      <SectionLabel
        aside={
          builds.length === 0
            ? undefined
            : `${builds.length} on the Device Host`
        }
      >
        Build
      </SectionLabel>
      {library.status === "loading" ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner
            aria-label="Loading the Build Library"
            className="text-text-3"
          />
        </div>
      ) : library.status === "failed" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <p className="max-w-72 text-[12.5px] text-text-2 select-text">
            {library.error}
          </p>
          <Button variant="ghost" size="sm" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : builds.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-[10px] border border-dashed border-white/15 bg-white/[0.015] p-6 text-center">
          <span className="flex size-11 items-center justify-center rounded-[11px] bg-white/[0.06] ring-1 ring-white/10">
            <UploadIcon className="size-5 text-text-2" />
          </span>
          <p className="text-[14px] font-medium">Drop a Build anywhere</p>
          <p className="max-w-64 text-[12.5px] text-text-2">
            A simulator Build (.zip) or an Android .apk, or choose one.
          </p>
        </div>
      ) : (
        <ul
          aria-label="Builds on the Device Host"
          className="-mx-1 flex max-h-[280px] min-h-0 thin-scroll flex-col gap-1 overflow-y-auto px-1"
        >
          {builds.map((listed) => {
            const isPicked = listed.id === build?.id
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
                  onClick={() => setPendingDelete(listed)}
                  className={cn(
                    "rounded-full text-text-3",
                    !isPicked &&
                      "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
                  )}
                >
                  <Trash2Icon />
                </Button>
              </li>
            )
          })}
        </ul>
      )}
      {deletedPick !== undefined && (
        <p role="status" className="text-[12.5px] text-amber">
          {deletedPick.name} {versionLabel(deletedPick)} was deleted from the
          Build Library. Pick another one.
        </p>
      )}
      <Button
        variant="outline"
        className="self-start"
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        <UploadIcon />
        Upload Build…
      </Button>
      <input
        ref={input}
        type="file"
        data-build-input=""
        accept=".zip,application/zip,.apk,application/vnd.android.package-archive"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ""
          if (file !== undefined) onChoose(file)
        }}
      />

      <AlertDialog
        open={pendingDelete !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(undefined)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this Build?</AlertDialogTitle>
            <AlertDialogDescription>
              Deleting “{pendingDelete?.name}{" "}
              {pendingDelete && versionLabel(pendingDelete)}” removes it from
              the Build Library for every Reviewer. To review it again, someone
              uploads it again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const doomed = pendingDelete
                setPendingDelete(undefined)
                if (doomed !== undefined) onDelete(doomed.id)
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
