import { useEffect, useState, type DragEvent } from "react"
import { BuildDropZone } from "@/components/build-drop-zone"
import { DevicePicker } from "@/components/device-picker"
import { HostNotReady } from "@/components/host-not-ready"
import { ProjectPicker } from "@/components/project-picker"
import { SessionScreen } from "@/components/session-screen"
import { StartReviewButton } from "@/components/start-review-button"
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
import { Spinner } from "@/components/ui/spinner"
import { useReview } from "@/lib/use-review"

export function App() {
  const model = useReview()
  const { review, host, projects, isBusy, errorMessage } = model
  const state = review.status === "loaded" ? review : undefined
  const session = state?.session
  const [isDragging, setIsDragging] = useState(false)
  // A Build dropped while the open session holds unfiled Findings waits for
  // the Reviewer to confirm what the upload would discard.
  const [pendingBuild, setPendingBuild] = useState<File>()
  const [confirmsEnd, setConfirmsEnd] = useState(false)
  const unfiled = session?.unfiledFindingCount ?? 0
  const unfiledPhrase =
    unfiled === 1 ? "1 unfiled Finding" : `${unfiled} unfiled Findings`

  useEffect(() => {
    document.title =
      session && state?.build
        ? `${state.build.name} · ${state.build.identity.version} (${state.build.identity.buildNumber}) · ${session.project.name}`
        : "nitpick"
  }, [session, state?.build])

  /**
   * Accepted on home and in a session alike, once the open session is known:
   * until then its unfiled Findings can't be counted for the guard. While work
   * runs the drop bounces with the busy message. The guard doesn't check the
   * file first: a stray non-Build over unfiled work confirms, then fails with
   * the ingest error and leaves the session alone.
   */
  function takeBuild(file: File) {
    if (state === undefined) return
    if (model.busy.current) {
      model.reportBusyDrop()
    } else if (unfiled > 0) {
      setPendingBuild(file)
    } else {
      void model.ingest(file)
    }
  }

  function dragOver(event: DragEvent) {
    if (!event.dataTransfer.types.includes("Files")) return
    event.preventDefault()
    setIsDragging(true)
  }

  function drop(event: DragEvent) {
    if (!event.dataTransfer.types.includes("Files")) return
    event.preventDefault()
    setIsDragging(false)
    const file = event.dataTransfer.files[0]
    if (file !== undefined) takeBuild(file)
  }

  function requestEndReview() {
    if (unfiled > 0) setConfirmsEnd(true)
    else void model.endReview()
  }

  return (
    <div
      className="flex min-h-svh flex-col"
      onDragOver={dragOver}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setIsDragging(false)
      }}
      onDrop={drop}
    >
      <header className="flex h-12 items-center justify-between border-b px-6">
        <span className="font-medium">nitpick</span>
        {isBusy && <Spinner aria-label="Working" />}
      </header>
      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 p-6">
        {review.status === "failed" && <ErrorLine message={review.error} />}
        {state?.build && session ? (
          <>
            <SessionScreen
              build={state.build}
              session={session}
              model={model}
              onEndReview={requestEndReview}
            />
            {errorMessage !== undefined && <ErrorLine message={errorMessage} />}
          </>
        ) : (
          <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-4">
            <BuildDropZone
              build={state?.build}
              isDragging={isDragging}
              disabled={isBusy || state === undefined}
              onChoose={takeBuild}
            />
            {host.status === "notReady" ? (
              <HostNotReady
                reason={host.reason}
                disabled={isBusy}
                onCheckAgain={model.checkHostAgain}
              />
            ) : (
              <DevicePicker
                variant="field"
                devices={model.devices}
                recentDeviceUDIDs={model.recentDeviceUDIDs}
                selected={model.selectedDevice}
                onSelect={model.selectDevice}
                disabled={isBusy || host.status === "loading"}
              />
            )}
            {projects.status === "failed" ? (
              <p className="text-sm text-muted-foreground">{projects.error}</p>
            ) : (
              <ProjectPicker
                projects={projects.status === "loaded" ? projects.projects : []}
                selectedID={model.selectedProjectID}
                onSelect={model.setSelectedProjectID}
              />
            )}
            <div className="flex justify-end">
              <StartReviewButton
                title={model.startTitle}
                missing={model.missingForStart}
                onStart={model.startReview}
              />
            </div>
            {errorMessage !== undefined && <ErrorLine message={errorMessage} />}
          </div>
        )}
      </main>

      <AlertDialog
        open={pendingBuild !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingBuild(undefined)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Ingest the dropped Build?</AlertDialogTitle>
            <AlertDialogDescription>
              Ingesting a new Build ends this review — {unfiledPhrase} will be
              discarded.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const file = pendingBuild
                setPendingBuild(undefined)
                if (file !== undefined) void model.ingest(file)
              }}
            >
              Discard and Ingest
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmsEnd} onOpenChange={setConfirmsEnd}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>End the review?</AlertDialogTitle>
            <AlertDialogDescription>
              Ending this review will discard {unfiledPhrase}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmsEnd(false)
                void model.endReview()
              }}
            >
              End Review
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** Ingest, launch and host failures, under the area where the Reviewer acted. */
function ErrorLine({ message }: { readonly message: string }) {
  return (
    <p role="alert" className="text-sm text-destructive select-text">
      {message}
    </p>
  )
}

export default App
