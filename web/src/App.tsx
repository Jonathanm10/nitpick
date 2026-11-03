import { useEffect, useRef, useState, type DragEvent } from "react"
import {
  trimWhitespaceAndNewlines,
  unfiledFindingCount,
  filedIssueOf,
  type YouTrackUser,
} from "@nitpick/core"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CameraIcon,
  FileUpIcon,
  HistoryIcon,
  KeyboardIcon,
  LogOutIcon,
  Maximize2Icon,
  MessageSquareWarningIcon,
  PlayIcon,
  SendIcon,
  SquareIcon,
  UploadIcon,
} from "lucide-react"
import { toast } from "sonner"
import {
  CommandPalette,
  type PaletteCommand,
} from "@/components/command-palette"
import { FeedbackDialog } from "@/components/feedback-dialog"
import { FilingResult } from "@/components/filing-result"
import { HistoryPage } from "@/components/history-page"
import { HomeScreen } from "@/components/home-screen"
import { Rail } from "@/components/rail"
import {
  refusalHints,
  SessionScreen,
  useStudioSession,
  type StudioSession,
} from "@/components/session-screen"
import { ShortcutsDialog } from "@/components/shortcuts-dialog"
import { SignInPage } from "@/components/sign-in-page"
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
import { Toaster } from "@/components/ui/sonner"
import { Spinner } from "@/components/ui/spinner"
import { api, APIError, onSignedOut } from "@/lib/api"
import { chords, isTextEntry } from "@/lib/chords"
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
          <Spinner aria-label="Loading" className="text-text-3" />
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

/**
 * The signed-in page: the rail, then home, the open session, the filing
 * result or History. ⌘K, ? and Send feedback reach their dialogs from
 * anywhere.
 */
function ReviewApp({
  reviewer,
  onSignedOut,
}: {
  readonly reviewer: YouTrackUser
  readonly onSignedOut: () => void
}) {
  const model = useReview()
  const studio = useStudioSession(model)
  const { review, isBusy, errorMessage } = model
  const state = review.status === "loaded" ? review : undefined
  const session = state?.session
  const [route, navigate] = useRoute()
  const showsHistory = route === historyRoute
  const filingResult =
    model.filing.status === "filed" ? model.filing.result : undefined
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  /** Counts openings, so every Send feedback starts blank. */
  const [feedbackOpening, setFeedbackOpening] = useState<number>()
  // State, not a ref: ⌘K's Choose Build… is built while rendering.
  const [buildInput, setBuildInput] = useState<HTMLInputElement | null>(null)

  function openHistory() {
    navigate(historyRoute)
    void model.refreshHistory()
  }
  function openFeedback() {
    setFeedbackOpening((count) => (count ?? 0) + 1)
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
  // page. While the Build runs, the chord returns to the Build: the device
  // takes the stage and focus, so typing goes to it. ⌘K opens the commands
  // from anywhere, a text field included; ? the shortcuts, outside fields.
  const latest = useRef({ model, studio })
  useEffect(() => {
    latest.current = { model, studio }
  })
  useEffect(() => {
    function keyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return
      if (chords.commands.matches(event)) {
        event.preventDefault()
        setPaletteOpen((open) => !open)
        return
      }
      if (chords.startReview.matches(event)) {
        event.preventDefault()
        const { model, studio } = latest.current
        if (model.run === undefined) void model.startReview()
        else studio.backToLive()
        return
      }
      if (
        event.key === "?" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !isTextEntry(event.target) &&
        document.querySelector("[role=dialog],[role=alertdialog]") === null
      ) {
        event.preventDefault()
        setShortcutsOpen(true)
      }
    }
    document.addEventListener("keydown", keyDown)
    return () => document.removeEventListener("keydown", keyDown)
  }, [])

  const commands = paletteCommands({
    model,
    studio,
    showsHistory,
    hasFilingResult: filingResult !== undefined,
    navigate,
    openHistory,
    chooseBuild: () => buildInput?.click(),
    requestEndReview,
    openFeedback,
    openShortcuts: () => setShortcutsOpen(true),
    signOut,
  })

  return (
    <div
      className="flex h-svh min-w-[1024px] overflow-hidden"
      onDragOver={dragOver}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setIsDragging(false)
      }}
      onDrop={drop}
    >
      <Rail
        reviewer={reviewer}
        page={showsHistory ? "history" : "review"}
        session={session === undefined ? "none" : model.run ? "live" : "paused"}
        onReview={() => navigate("")}
        onHistory={openHistory}
        onSendFeedback={openFeedback}
        onCommands={() => setPaletteOpen(true)}
        onShortcuts={() => setShortcutsOpen(true)}
        onSignOut={signOut}
      />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {showsHistory ? (
          <HistoryPage
            history={model.history}
            backLabel={session ? "Back to review" : "Back"}
            onBack={() => navigate("")}
            onImported={() => void model.refreshHistory()}
          />
        ) : state?.build && session ? (
          <SessionScreen
            session={session}
            build={state.build}
            model={model}
            studio={studio}
            onEndReview={requestEndReview}
            onOpenCommands={() => setPaletteOpen(true)}
          />
        ) : filingResult !== undefined ? (
          <div className="flex min-h-0 flex-1 flex-col canvas-dots">
            <FilingResult
              entry={filingResult}
              disabled={isBusy}
              onDone={() => void model.dismissFilingResult()}
              onOpenHistory={openHistory}
            />
            {errorMessage !== undefined && (
              <p
                role="alert"
                className="mx-auto mb-8 w-full max-w-2xl px-8 text-[13px] text-red select-text"
              >
                {errorMessage}
              </p>
            )}
          </div>
        ) : (
          <HomeScreen
            model={model}
            isDragging={isDragging}
            onChooseBuild={takeBuild}
            onOpenHistory={openHistory}
            onOpenCommands={() => setPaletteOpen(true)}
          />
        )}
      </main>
      {isDragging && !showsHistory && state !== undefined && (
        <DropOverlay unfiled={session === undefined ? undefined : unfiled} />
      )}
      <Toaster position="bottom-right" />
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        commands={commands}
      />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      {feedbackOpening !== undefined && (
        <FeedbackDialog
          key={feedbackOpening}
          review={
            state?.build && session
              ? {
                  build: state.build.identity,
                  hostName: "Simulator",
                  device: model.run?.device,
                }
              : undefined
          }
          onClose={() => setFeedbackOpening(undefined)}
        />
      )}
      <input
        ref={setBuildInput}
        type="file"
        accept=".zip,application/zip,.apk,application/vnd.android.package-archive"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ""
          if (file !== undefined) takeBuild(file)
        }}
      />

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

/** The page under a dragged file: a drop anywhere loads the Build. */
function DropOverlay({ unfiled }: { readonly unfiled: number | undefined }) {
  return (
    <div className="pointer-events-none fixed inset-0 z-40 flex animate-in items-center justify-center bg-[#07080a]/80 p-10 backdrop-blur-sm duration-150 fade-in motion-reduce:animate-none">
      <div className="flex h-full max-h-[520px] w-full max-w-[820px] flex-col items-center justify-center rounded-[22px] border-[1.5px] border-dashed border-white/25 bg-white/[0.02] text-center">
        <span className="mb-4 flex size-14 items-center justify-center rounded-[14px] bg-white/[0.06] ring-1 ring-white/15">
          <UploadIcon className="size-6" strokeWidth={1.75} />
        </span>
        <p className="text-[20px] font-semibold tracking-[-0.01em]">
          Drop to load the Build
        </p>
        <p className="mt-1.5 text-[13px] text-text-2">
          A .zip with a simulator .app inside, or an Android .apk
        </p>
        {unfiled !== undefined && (
          <p className="mt-4 rounded-full bg-amber/10 px-3 py-1 text-[12px] text-amber ring-1 ring-amber/25">
            A new Build ends this review
            {unfiled > 0 ? ` — you'll confirm first (${unfiled} unfiled)` : ""}
          </p>
        )}
      </div>
    </div>
  )
}

/** What ⌘K offers now: the review's actions, the Tray, then nitpick's own. */
function paletteCommands({
  model,
  studio,
  showsHistory,
  hasFilingResult,
  navigate,
  openHistory,
  chooseBuild,
  requestEndReview,
  openFeedback,
  openShortcuts,
  signOut,
}: {
  readonly model: ReturnType<typeof useReview>
  readonly studio: StudioSession
  readonly showsHistory: boolean
  readonly hasFilingResult: boolean
  readonly navigate: (route: string) => void
  readonly openHistory: () => void
  readonly chooseBuild: () => void
  readonly requestEndReview: () => void
  readonly openFeedback: () => void
  readonly openShortcuts: () => void
  readonly signOut: () => void
}): PaletteCommand[] {
  const { session, editor } = studio
  const commands: PaletteCommand[] = []
  /** A review command first leaves History for the review. */
  const inReview = (run: () => void) => () => {
    if (showsHistory) navigate("")
    run()
  }
  const startReview = inReview(() => void model.startReview())

  if (session !== undefined) {
    const group = "Review"
    commands.push({
      id: "capture",
      group,
      label: "Capture",
      icon: CameraIcon,
      keys: chords.capture.label,
      hint:
        studio.refusal === undefined ? undefined : refusalHints[studio.refusal],
      disabled: studio.refusal !== undefined,
      run: inReview(() => void studio.capture()),
    })
    if (editor.item !== undefined) {
      commands.push({
        id: "back-to-live",
        group,
        label: "Back to live",
        icon: Maximize2Icon,
        keys: "Esc",
        run: inReview(studio.backToLive),
      })
    }
    if (model.run === undefined) {
      commands.push({
        id: "resume",
        group,
        label: model.startTitle,
        icon: PlayIcon,
        keys: chords.startReview.label,
        hint: model.missingForStart,
        disabled: model.missingForStart !== undefined,
        run: startReview,
      })
    }
    commands.push(
      {
        id: "previous",
        group,
        label: "Previous Finding",
        icon: ArrowUpIcon,
        keys: chords.previousFinding.label,
        disabled: !editor.canStep("previous"),
        run: inReview(() => editor.step("previous")),
      },
      {
        id: "next",
        group,
        label: "Next Finding",
        icon: ArrowDownIcon,
        keys: chords.nextFinding.label,
        disabled: !editor.canStep("next"),
        run: inReview(() => editor.step("next")),
      },
      {
        id: "file-all",
        group,
        label:
          model.filingPhase?.phase === "remaining"
            ? `File ${model.filingPhase.unfiled} remaining`
            : "File all",
        icon: SendIcon,
        keys: chords.fileAll.label,
        hint:
          model.needingSummary.length === 0
            ? undefined
            : model.needingSummary.length === 1
              ? "1 Finding needs a summary"
              : `${model.needingSummary.length} Findings need a summary`,
        disabled: !studio.canFileAll,
        run: inReview(studio.fileAll),
      },
      {
        id: "end-review",
        group,
        label: "End review…",
        icon: SquareIcon,
        disabled: model.isBusy,
        run: inReview(requestEndReview),
      }
    )
    for (const item of session.tray.toReversed()) {
      const summary = trimWhitespaceAndNewlines(item.finding.summary)
      commands.push({
        id: `finding-${item.id}`,
        group: "Tray",
        label: summary === "" ? "Untitled Finding" : summary,
        hint:
          filedIssueOf(item)?.idReadable ??
          item.finding.deviceContext.deviceModel,
        run: inReview(() => editor.select(item.id)),
      })
    }
  } else if (!hasFilingResult) {
    commands.push({
      id: "start",
      group: "Review",
      label: model.startTitle,
      icon: PlayIcon,
      keys: chords.startReview.label,
      hint: model.missingForStart,
      disabled: model.missingForStart !== undefined,
      run: startReview,
    })
  }
  commands.push({
    id: "choose-build",
    group: "Build",
    label: session === undefined ? "Choose Build…" : "Load another Build…",
    icon: FileUpIcon,
    disabled: model.review.status !== "loaded" || model.isBusy,
    run: inReview(chooseBuild),
  })
  const group = "nitpick"
  commands.push(
    showsHistory
      ? {
          id: "review",
          group,
          label: session === undefined ? "Back to home" : "Back to review",
          icon: HistoryIcon,
          run: () => navigate(""),
        }
      : {
          id: "history",
          group,
          label: "Open History",
          icon: HistoryIcon,
          run: openHistory,
        },
    {
      id: "feedback",
      group,
      label: "Send feedback…",
      icon: MessageSquareWarningIcon,
      run: openFeedback,
    },
    {
      id: "shortcuts",
      group,
      label: "Keyboard shortcuts",
      icon: KeyboardIcon,
      keys: "?",
      run: openShortcuts,
    },
    {
      id: "sign-out",
      group,
      label: "Sign out",
      icon: LogOutIcon,
      run: signOut,
    }
  )
  return commands
}

export default App
