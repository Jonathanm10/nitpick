import { useRef, useState } from "react"
import type { BuildSummary, LibraryBuild } from "@nitpick/server/api"
import { UploadIcon } from "lucide-react"
import { cn } from "cn"
import { BuildLibraryList, versionLabel } from "@/components/build-library-list"
import { SectionLabel } from "@/components/studio"
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

/**
 * Home's first card: the Build Library, whose rows' delete controls ask
 * first. Empty, the card asks for a zipped simulator Build or an Android
 * .apk, dropped anywhere or chosen; an upload lands in the Library for
 * everyone.
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
      <BuildLibraryList
        library={library}
        picked={build?.id}
        disabled={disabled}
        empty={
          <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-[10px] border border-dashed border-white/15 bg-white/[0.015] p-6 text-center">
            <span className="flex size-11 items-center justify-center rounded-[11px] bg-white/[0.06] ring-1 ring-white/10">
              <UploadIcon className="size-5 text-text-2" />
            </span>
            <p className="text-[14px] font-medium">Drop a Build anywhere</p>
            <p className="max-w-64 text-[12.5px] text-text-2">
              A simulator Build (.zip) or an Android .apk, or choose one.
            </p>
          </div>
        }
        onPick={onPick}
        onDelete={setPendingDelete}
        onRetry={onRetry}
      />
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
