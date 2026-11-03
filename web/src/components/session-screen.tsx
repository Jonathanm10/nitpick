import { useEffect, useRef, useState } from "react"
import {
  captureRefusal,
  captureRefusalMessage,
  devicePlatform,
  isEditable,
  trimWhitespaceAndNewlines,
  unfiledFindingCount,
  type TrayItem,
} from "@nitpick/core"
import type { BuildSummary, SessionSummary } from "@nitpick/server/api"
import { CameraIcon, CommandIcon, LinkIcon, Maximize2Icon } from "lucide-react"
import { cn } from "cn"
import { AnnotationSurface } from "@/components/annotation-surface"
import {
  annotationTools,
  AnnotationToolbar,
} from "@/components/annotation-toolbar"
import { DevicePicker } from "@/components/device-picker"
import {
  DeviceStream,
  focusDeviceStream,
  type ScreenSize,
} from "@/components/device-stream"
import { FileAll } from "@/components/file-all"
import { FindingInspector } from "@/components/finding-fields"
import { HostNotReady } from "@/components/host-not-ready"
import { StartReviewButton } from "@/components/start-review-button"
import { InspectorSection, ProjectKey, Tip } from "@/components/studio"
import { Tray } from "@/components/tray"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Kbd } from "@/components/ui/kbd"
import { Spinner } from "@/components/ui/spinner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { api } from "@/lib/api"
import { chords, isTextEntry } from "@/lib/chords"
import {
  defaultScreen,
  deviceChrome,
  pipWidth,
  stageDeviceWidth,
  useElementSize,
  useFlip,
} from "@/lib/stage-layout"
import { useCaptureImage } from "@/lib/use-capture-image"
import { useEditor, type Editor } from "@/lib/use-editor"
import type { useReview } from "@/lib/use-review"

type Review = ReturnType<typeof useReview>

/**
 * The open session's Editor and the actions the stage, the shortcuts and
 * the command palette share: capture, File all and back to live. It lives
 * with the page, so ⌘K reaches it from anywhere.
 */
export function useStudioSession(model: Review) {
  const session =
    model.review.status === "loaded" ? model.review.session : undefined
  const { run, isBusy } = model
  const editor = useEditor({
    session,
    isBusy,
    onAnnotations: (itemID, annotations) =>
      model.editFinding(itemID, { annotations }),
    onDiscard: (itemID) => void model.discard(itemID),
  })
  const refusal = captureRefusal({
    isReviewing: run !== undefined,
    isBusy,
    hasPendingLabelDraft: editor.editor.hasPendingLabelDraft,
  })
  /** Bumped on every capture that starts, for the shutter flash. */
  const [shutter, setShutter] = useState(0)

  /** The capture lands in the Tray, selected, on the stage. */
  async function capture() {
    if (refusal !== undefined) {
      model.setErrorMessage(
        captureRefusalMessage(refusal, chords.capture.label)
      )
      return
    }
    setShutter((count) => count + 1)
    const id = await model.capture()
    if (id !== undefined) editor.open(id)
  }

  /**
   * Something left to file, every editable Finding with its summary, and
   * no open text label, whose commit would land after its Finding filed.
   */
  const canFileAll =
    session !== undefined &&
    !isBusy &&
    !editor.editor.hasPendingLabelDraft &&
    unfiledFindingCount(session) > 0 &&
    model.needingSummary.length === 0

  function fileAll() {
    if (canFileAll) void model.fileAll()
  }

  /**
   * Closes the open Finding, so the device takes the stage, and gives the
   * device focus, so typing goes to it.
   */
  function backToLive() {
    if (editor.close()) focusDeviceStream()
  }

  return {
    session,
    editor,
    refusal,
    shutter,
    capture,
    canFileAll,
    fileAll,
    backToLive,
  }
}

export type StudioSession = ReturnType<typeof useStudioSession>

/**
 * The open Review Session as a workspace: the top bar with the Build and
 * the Device Context, then the Tray with File all at its foot, the stage
 * and the inspector. Selecting a Finding puts its capture on the stage and
 * moves the live device into the stage's corner; back to live returns it.
 * Below 1024 px the page scrolls sideways rather than squeeze the stage.
 */
export function SessionScreen({
  session,
  build,
  model,
  studio,
  onEndReview,
  onOpenCommands,
}: {
  readonly session: SessionSummary
  readonly build: BuildSummary
  readonly model: Review
  readonly studio: StudioSession
  readonly onEndReview: () => void
  readonly onOpenCommands: () => void
}) {
  const { host, run, isBusy } = model
  const { editor } = studio
  const item = editor.item

  useSessionChords(studio)

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-panel/60 px-4">
        <ProjectKey project={session.project} />
        <h1 className="flex min-w-0 items-baseline gap-2 truncate text-[13.5px]">
          <span className="truncate font-medium">{build.name}</span>
          <span className="shrink-0 font-mono text-[12px] text-text-2">
            {build.identity.version} ({build.identity.buildNumber})
          </span>
        </h1>
        <span className="h-4 w-px shrink-0 bg-line-strong" />
        <span className="flex shrink-0 items-center gap-2 text-[12.5px] text-text-2">
          {run === undefined ? (
            <>
              <span className="size-[7px] rounded-full bg-amber" />
              Paused
            </>
          ) : (
            "Review in progress"
          )}
        </span>
        <span className="flex-1" />
        {isBusy && <Spinner aria-label="Working" className="text-text-3" />}
        {host.status !== "notReady" && (
          <DevicePicker
            variant="chip"
            devices={model.devices}
            recentDeviceUDIDs={model.recentDeviceUDIDs}
            selected={model.selectedDevice ?? run?.device}
            onSelect={model.selectDevice}
            disabled={isBusy}
            isLive={run !== undefined}
          />
        )}
        {run === undefined && host.status !== "notReady" && (
          <StartReviewButton
            title={model.startTitle}
            missing={model.missingForStart}
            onStart={model.startReview}
          />
        )}
        <Button
          variant="ghost"
          size="sm"
          aria-label="Commands"
          title="Commands"
          className="text-text-2"
          onClick={onOpenCommands}
        >
          <CommandIcon />
          <Kbd>{chords.commands.label}</Kbd>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-text-2"
          disabled={isBusy}
          onClick={onEndReview}
        >
          End Review
        </Button>
      </header>

      {host.status === "notReady" && (
        <div className="border-b px-4 py-2">
          <HostNotReady
            reason={host.reason}
            disabled={isBusy}
            onCheckAgain={model.checkHostAgain}
          />
        </div>
      )}
      {[model.errorMessage, model.saveError].map(
        (message) =>
          message !== undefined && (
            <p
              key={message}
              role="alert"
              className="border-b border-red/20 bg-red/[0.07] px-4 py-2 text-[12.5px] text-red select-text"
            >
              {message}
            </p>
          )
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[15rem_minmax(0,1fr)_18rem] xl:grid-cols-[18rem_minmax(0,1fr)_21rem]">
        <aside className="flex min-h-0 flex-col border-r bg-panel">
          <Tray
            session={session}
            filing={model.filing}
            editor={editor}
            onDiscard={model.discard}
          />
          {session.tray.length > 0 && model.filingPhase !== undefined && (
            <FileAll
              phase={model.filingPhase}
              needingSummary={model.needingSummary}
              canFileAll={studio.canFileAll}
              onFileAll={studio.fileAll}
              onSelect={editor.select}
            />
          )}
        </aside>

        <Stage session={session} model={model} studio={studio} />

        <aside
          aria-label="Inspector"
          className="flex min-h-0 thin-scroll flex-col overflow-y-auto border-l bg-panel"
        >
          {item === undefined ? (
            <SessionInspector session={session} build={build} model={model} />
          ) : (
            <FindingInspector
              key={item.id}
              item={item}
              session={session}
              schema={model.schema}
              disabled={isBusy}
              review={model}
              onReturn={studio.backToLive}
            />
          )}
        </aside>
      </div>
    </div>
  )
}

/**
 * The middle of the workspace on a dotted canvas. With no Finding open the
 * live device stands in the middle, Capture under it; with one open, its
 * capture takes the stage, the toolbar floats over it, and the device
 * moves to the corner, still live. The device's element never remounts,
 * so the stream never reconnects.
 */
function Stage({
  session,
  model,
  studio,
}: {
  readonly session: SessionSummary
  readonly model: Review
  readonly studio: StudioSession
}) {
  const { run } = model
  const { editor } = studio
  const item = editor.item
  const stageRef = useRef<HTMLDivElement>(null)
  const stage = useElementSize(stageRef)
  const isPip = item !== undefined
  const pip = pipWidth(stage)
  const index = item === undefined ? -1 : session.tray.indexOf(item)

  return (
    <section
      aria-label="Stage"
      className="relative flex min-h-0 min-w-0 flex-col canvas-dots"
    >
      <div ref={stageRef} className="relative min-h-0 flex-1 overflow-hidden">
        {item !== undefined && (
          <>
            <div
              className={cn(
                "absolute top-3 left-1/2 z-10 -translate-x-1/2",
                !isEditable(item) && "invisible"
              )}
              aria-hidden={!isEditable(item)}
            >
              <AnnotationToolbar editor={editor} />
            </div>
            <div
              className="absolute top-[4.25rem] bottom-5 left-5 flex"
              style={{ right: pip + 40 }}
            >
              <CaptureView key={item.id} item={item} editor={editor} />
            </div>
          </>
        )}
        <LiveSlot
          isPip={isPip}
          stage={stage}
          pipWidth={pip}
          model={model}
          studio={studio}
        />
      </div>
      <footer className="flex h-8 shrink-0 items-center gap-3 overflow-hidden border-t bg-canvas/80 px-4 text-[11.5px] whitespace-nowrap text-text-3">
        {item === undefined ? (
          <>
            <span className="flex items-center gap-1.5">
              {run === undefined ? (
                <span className="size-[7px] rounded-full bg-amber" />
              ) : (
                <span className="live-dot" />
              )}
              {run === undefined ? "Paused" : `Live · ${run.device.name}`}
            </span>
            <span className="flex-1" />
            <Hint keys={chords.capture.label}>capture</Hint>
            <Hint keys={chords.commands.label}>commands</Hint>
          </>
        ) : (
          <>
            <span className="text-text-2">
              Finding {index + 1} of {session.tray.length}
            </span>
            <span className="h-3 w-px bg-line-strong" />
            <button
              type="button"
              onClick={studio.backToLive}
              className="flex items-center gap-1.5 hover:text-foreground"
            >
              Back to live <Kbd>Esc</Kbd>
            </button>
            <span className="flex-1" />
            {editor.canEdit && (
              <>
                <span className="hidden items-center gap-1 min-[1180px]:flex">
                  {annotationTools.map((tool) => (
                    <Kbd key={tool.tool}>{tool.key}</Kbd>
                  ))}
                  <span className="ml-1">tools</span>
                </span>
                <Hint keys={chords.undo.label}>undo</Hint>
              </>
            )}
          </>
        )}
      </footer>
    </section>
  )
}

function Hint({
  keys,
  children,
}: {
  readonly keys: string
  readonly children: React.ReactNode
}) {
  return (
    <span className="flex items-center gap-1.5">
      <Kbd>{keys}</Kbd>
      {children}
    </span>
  )
}

/**
 * The live device with Capture under it: in the middle of the stage, or in
 * its corner while a Finding is open. Paused, the slot says how to resume.
 */
function LiveSlot({
  isPip,
  stage,
  pipWidth,
  model,
  studio,
}: {
  readonly isPip: boolean
  readonly stage: ScreenSize
  readonly pipWidth: number
  readonly model: Review
  readonly studio: StudioSession
}) {
  const { run } = model
  const device = run?.device
  const platform = device === undefined ? undefined : devicePlatform(device)
  const [reported, setReported] = useState<{
    readonly udid: string
    readonly screen: ScreenSize
  }>()
  const screen =
    device !== undefined && reported?.udid === device.udid
      ? reported.screen
      : defaultScreen(platform)
  const width = isPip ? pipWidth : stageDeviceWidth(stage, screen)
  const { bezel, screenRadius, outerRadius } = deviceChrome(
    width,
    screen,
    platform
  )
  const frame = {
    className: "device-bezel",
    style: {
      padding: bezel,
      borderRadius: outerRadius,
      "--screen-radius": `${screenRadius}px`,
    } as React.CSSProperties,
  }
  const block = useRef<HTMLDivElement>(null)
  useFlip(block, isPip)

  const refusal = studio.refusal
  const captureButton = (
    <Button
      className={cn(
        "w-full border-0 font-semibold btn-red",
        isPip ? "h-8 rounded-[9px]" : "h-10 rounded-[10px] text-[14px]"
      )}
      disabled={refusal !== undefined}
      onClick={() => void studio.capture()}
    >
      <CameraIcon />
      Capture
      {!isPip && (
        <Kbd className="bg-white/20 text-white/90 in-disabled:bg-white/5 in-disabled:text-text-3">
          {chords.capture.label}
        </Kbd>
      )}
    </Button>
  )

  return (
    <div
      className={cn(
        "pointer-events-none absolute flex",
        isPip
          ? "right-5 bottom-5 items-end"
          : "inset-0 items-center justify-center"
      )}
    >
      <div
        ref={block}
        className="pointer-events-auto flex flex-col gap-2.5"
        style={{ width }}
      >
        {isPip && (
          <div className="flex items-center gap-2 px-0.5 text-[11px] text-text-2">
            {run === undefined ? (
              <span className="size-[7px] rounded-full bg-amber" />
            ) : (
              <span className="live-dot" />
            )}
            <span className="font-medium tracking-wide text-foreground uppercase">
              {run === undefined ? "Paused" : "Live"}
            </span>
            <span className="min-w-0 flex-1 truncate text-right">
              {device?.name}
            </span>
            <Tip label="Back to live" chord="Esc" side="top">
              <button
                type="button"
                aria-label="Back to live"
                onClick={studio.backToLive}
                className="-mr-1 rounded p-0.5 text-text-3 hover:bg-white/10 hover:text-foreground"
              >
                <Maximize2Icon className="size-3.5" />
              </button>
            </Tip>
          </div>
        )}
        <div className="relative">
          {device === undefined ? (
            <div className="device-bezel" style={frame.style}>
              <PausedScreen model={model} />
            </div>
          ) : (
            <DeviceStream
              key={device.udid}
              device={device}
              frame={frame}
              onScreen={(next) =>
                setReported({ udid: device.udid, screen: next })
              }
            />
          )}
          {studio.shutter > 0 && (
            <div
              key={studio.shutter}
              aria-hidden
              className="pointer-events-none absolute inset-0 shutter-flash bg-white"
              style={{ borderRadius: outerRadius }}
            />
          )}
        </div>
        {device !== undefined &&
          (refusal === undefined ? (
            captureButton
          ) : (
            <Tooltip>
              <TooltipTrigger render={<span tabIndex={0} className="flex" />}>
                {captureButton}
              </TooltipTrigger>
              <TooltipContent>{refusalHints[refusal]}</TooltipContent>
            </Tooltip>
          ))}
      </div>
    </div>
  )
}

/** The device's place while the review is paused. */
function PausedScreen({ model }: { readonly model: Review }) {
  return (
    <div className="flex aspect-[9/19.5] w-full flex-col items-center justify-center gap-3 rounded-[var(--screen-radius)] bg-black/60 p-4 text-center text-[12px] text-text-2">
      <p>
        Resume review to run the Build. {chords.startReview.label} does it from
        anywhere.
      </p>
      {model.missingForStart !== undefined && (
        <p className="text-text-3">{model.missingForStart}</p>
      )}
    </div>
  )
}

/** Why Capture is disabled, for its tooltip and ⌘K. */
export const refusalHints: Record<
  NonNullable<ReturnType<typeof captureRefusal>>,
  string
> = {
  reviewPaused: "Resume review to capture.",
  busy: "nitpick is busy. Try again in a moment.",
  labelDraftPending: "Finish the open text label first.",
}

/** The selected Finding's capture: editable, or frozen once filing began. */
function CaptureView({
  item,
  editor,
}: {
  readonly item: TrayItem
  readonly editor: Editor
}) {
  const image = useCaptureImage(api.captureURL(item.id))
  if (image.status === "loaded") {
    return (
      <AnnotationSurface
        key={editor.editor.generation}
        editor={editor}
        image={image.image}
        editable={isEditable(item)}
      />
    )
  }
  return (
    <div className="flex flex-1 items-start justify-center pt-12 text-sm text-text-2">
      {image.status === "failed" ? "The capture couldn't be loaded." : ""}
    </div>
  )
}

/**
 * The inspector while no Finding is open: the session itself — its Build,
 * project and device, and the Design Reference every Finding files under.
 */
function SessionInspector({
  session,
  build,
  model,
}: {
  readonly session: SessionSummary
  readonly build: BuildSummary
  readonly model: Review
}) {
  const device = model.run?.device ?? model.selectedDevice
  return (
    <>
      <div className="flex h-11 shrink-0 items-center border-b px-4 text-[13px] font-medium">
        Review Session
      </div>
      <InspectorSection label="Build">
        <p className="text-[13px] font-medium">{build.name}</p>
        <p className="font-mono text-[11.5px] text-text-2 select-text">
          {build.identity.version} ({build.identity.buildNumber}) ·{" "}
          {build.identity.bundleID}
        </p>
      </InspectorSection>
      <InspectorSection label="YouTrack project">
        <p className="flex items-center gap-2 text-[13px]">
          <ProjectKey project={session.project} />
          {session.project.name}
        </p>
        <p className="text-[11.5px] text-text-3">
          Pinned when the review started.
        </p>
      </InspectorSection>
      <InspectorSection label="Design Reference">
        <SessionDesignReference
          key={session.startedAt}
          value={session.designReference}
          disabled={model.isBusy}
          onChange={model.editSessionDesignReference}
        />
        <p className="text-[11.5px] text-text-3">
          Filed with every Finding, unless a Finding sets its own.
        </p>
      </InspectorSection>
      <InspectorSection label="Device">
        <p className="text-[13px]">
          {device === undefined ? "No device selected" : device.name}
          {device !== undefined && (
            <span className="ml-2 font-mono text-[11.5px] text-text-2">
              {device.osName}
            </span>
          )}
        </p>
      </InspectorSection>
      <InspectorSection label="Keys">
        <dl className="grid grid-cols-[1fr_auto] gap-y-1.5 text-[12px] text-text-2">
          <dt>Capture</dt>
          <dd>
            <Kbd>{chords.capture.label}</Kbd>
          </dd>
          <dt>Previous / next Finding</dt>
          <dd className="flex gap-1">
            <Kbd>{chords.previousFinding.label}</Kbd>
            <Kbd>{chords.nextFinding.label}</Kbd>
          </dd>
          <dt>File all</dt>
          <dd>
            <Kbd>{chords.fileAll.label}</Kbd>
          </dd>
          <dt>Every command</dt>
          <dd>
            <Kbd>{chords.commands.label}</Kbd>
          </dd>
        </dl>
      </InspectorSection>
    </>
  )
}

/**
 * The Figma URL every Finding of the session files under, unless one sets
 * its own (ADR-0003).
 */
function SessionDesignReference({
  value,
  disabled,
  onChange,
}: {
  readonly value: string | undefined
  readonly disabled: boolean
  readonly onChange: (designReference: string | undefined) => void
}) {
  const [text, setText] = useState(value ?? "")
  return (
    <div className="relative">
      <LinkIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-text-3" />
      <Input
        aria-label="Design Reference for all Findings"
        placeholder="Figma URL for every Finding"
        title="A Figma URL filed with every Finding of this session, unless a Finding sets its own."
        className="pl-8 font-mono text-[12px] placeholder:font-sans"
        value={text}
        disabled={disabled}
        onChange={(event) => {
          setText(event.target.value)
          const trimmed = trimWhitespaceAndNewlines(event.target.value)
          onChange(trimmed === "" ? undefined : trimmed)
        }}
      />
    </div>
  )
}

/**
 * The session's chords, on the document so they work wherever focus is.
 * A text field keeps its letters and its own undo; a dialog or popup keeps
 * every key but ⌘S, which never opens the browser's Save dialog here.
 */
function useSessionChords(studio: StudioSession) {
  const latest = useRef(studio)
  useEffect(() => {
    latest.current = studio
  })

  useEffect(() => {
    function keyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return
      const { editor, capture, fileAll, backToLive } = latest.current
      const inField = isTextEntry(event.target)
      // Dialogs and popups render outside the page's root.
      const inPopup =
        event.target instanceof Node &&
        event.target !== document.body &&
        !document.getElementById("root")?.contains(event.target)

      if (chords.capture.matches(event)) {
        event.preventDefault()
        if (!inPopup) void capture()
        return
      }
      if (inPopup) return
      if (chords.fileAll.matches(event)) {
        event.preventDefault()
        fileAll()
        return
      }
      if (chords.undo.matches(event) || chords.redo.matches(event)) {
        if (inField) return
        event.preventDefault()
        if (chords.undo.matches(event)) editor.undo()
        else editor.redo()
        return
      }
      if (chords.previousFinding.matches(event)) {
        event.preventDefault()
        editor.step("previous")
        return
      }
      if (chords.nextFinding.matches(event)) {
        event.preventDefault()
        editor.step("next")
        return
      }
      if (event.key === "Escape") {
        // An untouched capture goes; otherwise Esc returns to live.
        if (editor.escape(false)) {
          event.preventDefault()
        } else if (!inField && editor.item !== undefined) {
          event.preventDefault()
          backToLive()
        }
        return
      }
      if (
        inField ||
        !editor.canEdit ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey
      ) {
        return
      }
      const tool = annotationTools.find(
        (candidate) => candidate.key.toLowerCase() === event.key
      )
      if (tool !== undefined) {
        event.preventDefault()
        editor.setTool(tool.tool)
      }
    }
    document.addEventListener("keydown", keyDown)
    return () => document.removeEventListener("keydown", keyDown)
  }, [])
}
