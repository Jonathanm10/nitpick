import { useEffect, useRef, useState, type DragEvent } from "react"
import { unfiledFindingCount, type YouTrackUser } from "@nitpick/core"
import { HistoryIcon } from "lucide-react"
import { toast } from "sonner"
import { BuildDropZone } from "@/components/build-drop-zone"
import { DevicePicker } from "@/components/device-picker"
import { focusDeviceStream } from "@/components/device-stream"
import { FeedbackButton } from "@/components/feedback-dialog"
import { FilingResult } from "@/components/filing-result"
import { HistoryPage } from "@/components/history-page"
import { HistoryTraceLine } from "@/components/history-trace-line"
import { HostNotReady } from "@/components/host-not-ready"
import { ProjectPicker } from "@/components/project-picker"
import { SessionScreen } from "@/components/session-screen"
import { ShortcutsDialog } from "@/components/shortcuts-dialog"
import { SignInPage } from "@/components/sign-in-page"
import { StartReviewButton } from "@/components/start-review-button"
import { UserMenu } from "@/components/user-menu"
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
import { Toaster } from "@/components/ui/sonner"
import { Spinner } from "@/components/ui/spinner"
import { api, APIError, onSignedOut } from "@/lib/api"
import { chords } from "@/lib/chords"
import { useReview } from "@/lib/use-review"

/** The History page's address; a hash, so the server serves one page. */
const historyRoute = "#/history"

/** Which page shows: the review, or History. Back and Forward work. */
function useRoute() {
  const [route, setRoute] = useState(() => window.location.hash)
  useEffect(() => {
    const changed = () => setRoute(window.location.hash)
    window.addEventListener("popstate", changed)
    return () => window.removeEventListener("popstate", changed)
  }, [])
  function navigate(next: string) {
    window.history.pushState(null, "", next || window.location.pathname)
    setRoute(next)
  }
  return [route, navigate] as const
}

type SignInState =
  | { readonly status: "checking" }
  | { readonly status: "signedOut"; readonly notice?: string }
  | { readonly status: "signedIn"; readonly reviewer: YouTrackUser }

/**
 * Sign-in first: every call but sign-in needs it. A 401 from any call while
 * signed in brings sign-in back with the server's reason, such as a token
 * YouTrack stopped taking; the open session stays on the server.
 */
export function App() {
  const [signIn, setSignIn] = useState<SignInState>({ status: "checking" })

  useEffect(() => {
    const unsubscribe = onSignedOut((reason) =>
      setSignIn((current) =>
        current.status === "signedIn"
          ? { status: "signedOut", notice: reason }
          : current
      )
    )
    api.me().then(
      ({ reviewer }) => setSignIn({ status: "signedIn", reviewer }),
      (error: unknown) =>
        setSignIn({
          status: "signedOut",
          notice:
            error instanceof APIError && error.code !== "signIn"
              ? error.message
              : undefined,
        })
    )
    return unsubscribe
  }, [])

  switch (signIn.status) {
    case "checking":
      return (
        <div className="flex min-h-svh items-center justify-center">
          <Spinner aria-label="Loading" />
        </div>
      )
    case "signedOut":
      return (
        <SignInPage
          notice={signIn.notice}
          onSignedIn={(reviewer) => setSignIn({ status: "signedIn", reviewer })}
        />
      )
    case "signedIn":
      return (
        // A Reviewer signing in afresh starts from the server's state.
        <ReviewApp
          key={signIn.reviewer.login}
          reviewer={signIn.reviewer}
          onSignedOut={() => setSignIn({ status: "signedOut" })}
        />
      )
  }
}

function ReviewApp({
  reviewer,
  onSignedOut,
}: {
  readonly reviewer: YouTrackUser
  readonly onSignedOut: () => void
}) {
  const model = useReview()
  const { review, host, projects, isBusy, errorMessage } = model
  const state = review.status === "loaded" ? review : undefined
  const session = state?.session
  const [route, navigate] = useRoute()
  const showsHistory = route === historyRoute
  const filingResult =
    model.filing.status === "filed" ? model.filing.result : undefined

  function openHistory() {
    navigate(historyRoute)
    void model.refreshHistory()
  }
  const [isDragging, setIsDragging] = useState(false)
  // A Build dropped while the open session holds unfiled Findings waits for
  // the Reviewer to confirm what the upload would discard.
  const [pendingBuild, setPendingBuild] = useState<File>()
  const [confirmsEnd, setConfirmsEnd] = useState(false)
  const unfiled = session === undefined ? 0 : unfiledFindingCount(session)
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
    if (state === undefined || showsHistory) return
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

  /**
   * Pending edits go to the open session first, which waits for the next
   * sign-in. Sign-in shows only once the server has ended the sign-in.
   */
  function signOut() {
    void model
      .saveEdits()
      .catch(() => false)
      .then(() => api.signOut())
      .then(onSignedOut, (error: unknown) =>
        toast.error(
          `Signing out failed: ${error instanceof Error ? error.message : String(error)}`
        )
      )
  }

  function requestEndReview() {
    if (unfiled > 0) setConfirmsEnd(true)
    else void model.endReview()
  }

  // Start review and Resume review: ⌘⏎ / Ctrl+Enter, since ⌘R reloads the
  // page. While the Build runs, the chord returns to the Build: focus moves
  // to the device, so typing goes to it.
  const startChord = useRef(() => {})
  useEffect(() => {
    startChord.current = () => {
      if (model.run === undefined) void model.startReview()
      else focusDeviceStream()
    }
  })
  useEffect(() => {
    function keyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || !chords.startReview.matches(event)) return
      event.preventDefault()
      startChord.current()
    }
    document.addEventListener("keydown", keyDown)
    return () => document.removeEventListener("keydown", keyDown)
  }, [])

  return (
    <div
      className="flex min-h-svh flex-col"
      onDragOver={dragOver}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setIsDragging(false)
      }}
      onDrop={drop}
    >
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-6">
        <span className="font-medium">nitpick</span>
        {state?.build && session && (
          <span className="truncate text-sm text-muted-foreground">
            <span className="font-medium text-foreground">
              {state.build.name}
            </span>{" "}
            {state.build.identity.version} ({state.build.identity.buildNumber})
            · {session.project.name}
          </span>
        )}
        <span className="flex-1" />
        {isBusy && <Spinner aria-label="Working" />}
        <Button
          variant="ghost"
          size="sm"
          aria-current={showsHistory ? "page" : undefined}
          onClick={openHistory}
        >
          <HistoryIcon />
          History
        </Button>
        <FeedbackButton
          review={
            state?.build && session
              ? {
                  build: state.build.identity,
                  hostName: "Simulator",
                  device: model.run?.device,
                }
              : undefined
          }
        />
        <ShortcutsDialog />
        <UserMenu reviewer={reviewer} onSignOut={signOut} />
      </header>
      <main
        className={
          state?.build && session && !showsHistory
            ? "flex h-[calc(100svh-3rem)] min-h-[40rem] flex-col gap-4 p-4"
            : "mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 p-6"
        }
      >
        {review.status === "failed" && <ErrorLine message={review.error} />}
        {showsHistory ? (
          <HistoryPage
            history={model.history}
            onBack={() => navigate("")}
            onImported={() => void model.refreshHistory()}
          />
        ) : state?.build && session ? (
          <SessionScreen
            session={session}
            model={model}
            onEndReview={requestEndReview}
          />
        ) : filingResult !== undefined ? (
          <>
            <FilingResult
              entry={filingResult}
              disabled={isBusy}
              onDone={() => void model.dismissFilingResult()}
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
        {!showsHistory &&
          !session &&
          filingResult === undefined &&
          model.trace !== undefined && (
            <HistoryTraceLine trace={model.trace} onOpenHistory={openHistory} />
          )}
      </main>
      <Toaster position="bottom-center" />

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
