import { useEffect, useRef, useState } from "react"
import {
  capturePlaceholder,
  captureRefusal,
  captureRefusalMessage,
  isEditable,
  trimWhitespaceAndNewlines,
  unfiledFindingCount,
  type TrayItem,
} from "@nitpick/core"
import type { SessionSummary } from "@nitpick/server/api"
import { CameraIcon, LinkIcon } from "lucide-react"
import { AnnotationSurface } from "@/components/annotation-surface"
import {
  annotationTools,
  AnnotationToolbar,
} from "@/components/annotation-toolbar"
import { DevicePicker } from "@/components/device-picker"
import { FileAll } from "@/components/file-all"
import { FindingFields } from "@/components/finding-fields"
import { HostNotReady } from "@/components/host-not-ready"
import { StartReviewButton } from "@/components/start-review-button"
import { Tray } from "@/components/tray"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Kbd } from "@/components/ui/kbd"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { api } from "@/lib/api"
import { chords, isTextEntry } from "@/lib/chords"
import { useCaptureImage } from "@/lib/use-capture-image"
import { useEditor, type Editor } from "@/lib/use-editor"
import type { useReview } from "@/lib/use-review"

type Review = ReturnType<typeof useReview>

/**
 * The open Review Session: the top bar with the Device Context, the status
 * and Resume review while paused, then three columns. The device on the
 * left with Capture under it, where the live stream goes; the Editor in the
 * middle; the session's Design Reference, the Tray with File all, the
 * Finding's fields and End Review on the right. Below 1024 px the page scrolls sideways
 * rather than squeeze the Editor; the side columns narrow below 1280 px.
 */
export function SessionScreen({
  session,
  model,
  onEndReview,
}: {
  readonly session: SessionSummary
  readonly model: Review
  readonly onEndReview: () => void
}) {
  const { host, run, isBusy } = model
  const editor = useEditor({
    session,
    isBusy,
    onAnnotations: (itemID, annotations) =>
      model.editFinding(itemID, { annotations }),
    onDiscard: (itemID) => void model.discard(itemID),
  })
  const item = editor.item
  const refusal = captureRefusal({
    isReviewing: run !== undefined,
    isBusy,
    hasPendingLabelDraft: editor.editor.hasPendingLabelDraft,
  })

  /** The capture lands in the Tray, selected, with focus on the capture. */
  async function capture() {
    if (refusal !== undefined) {
      model.setErrorMessage(
        captureRefusalMessage(refusal, chords.capture.label)
      )
      return
    }
    const id = await model.capture()
    if (id !== undefined) editor.open(id)
  }

  /**
   * Something left to file, every editable Finding with its summary, and
   * no open text label, whose commit would land after its Finding filed.
   */
  const canFileAll =
    !isBusy &&
    !editor.editor.hasPendingLabelDraft &&
    unfiledFindingCount(session) > 0 &&
    model.needingSummary.length === 0

  function fileAll() {
    if (canFileAll) void model.fileAll()
  }

  useSessionChords({
    editor,
    onCapture: () => void capture(),
    onFileAll: fileAll,
  })

  return (
    <div className="flex min-h-0 min-w-224 flex-1 flex-col gap-3">
      {host.status === "notReady" ? (
        <HostNotReady
          reason={host.reason}
          disabled={isBusy}
          onCheckAgain={model.checkHostAgain}
        />
      ) : (
        <div className="flex min-h-11 items-center gap-3 rounded-xl border bg-muted/40 py-1.5 pr-2 pl-1.5">
          <DevicePicker
            variant="chip"
            devices={model.devices}
            recentDeviceUDIDs={model.recentDeviceUDIDs}
            selected={model.selectedDevice ?? run?.device}
            onSelect={model.selectDevice}
            disabled={isBusy}
          />
          <span className="h-4.5 w-px bg-border" />
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <span
              className={`size-2 rounded-full ${run ? "bg-green-500" : "bg-muted-foreground/40"}`}
            />
            {run ? "Review in progress" : "Ready to resume"}
          </span>
          <span className="flex-1" />
          {run === undefined && (
            <StartReviewButton
              title={model.startTitle}
              missing={model.missingForStart}
              onStart={model.startReview}
            />
          )}
        </div>
      )}
      {[model.errorMessage, model.saveError].map(
        (message) =>
          message !== undefined && (
            <p
              key={message}
              role="alert"
              className="text-sm text-destructive select-text"
            >
              {message}
            </p>
          )
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[14rem_minmax(20rem,1fr)_20rem] gap-4 xl:grid-cols-[16rem_minmax(20rem,1fr)_22rem] xl:gap-5">
        <DeviceColumn
          deviceName={run?.device.name}
          refusal={refusal}
          onCapture={() => void capture()}
        />

        <div className="flex min-h-0 flex-col gap-2.5">
          {/* The toolbar's slot stays when it hides, so switching between
              editable and frozen rows never resizes the capture. */}
          <div
            className={
              item !== undefined && isEditable(item) ? "" : "invisible"
            }
            aria-hidden={item === undefined || !isEditable(item)}
          >
            <AnnotationToolbar editor={editor} />
          </div>
          {item === undefined ? (
            <CapturePlaceholder isReviewing={run !== undefined} />
          ) : (
            <CaptureView key={item.id} item={item} editor={editor} />
          )}
        </div>

        <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1 pb-1">
          <SessionDesignReference
            key={session.startedAt}
            value={session.designReference}
            disabled={isBusy}
            onChange={model.editSessionDesignReference}
          />
          {session.tray.length > 0 && (
            <>
              <Tray
                session={session}
                filing={model.filing}
                editor={editor}
                onDiscard={model.discard}
              />
              {model.filingPhase !== undefined && (
                <FileAll
                  phase={model.filingPhase}
                  needingSummary={model.needingSummary}
                  canFileAll={canFileAll}
                  onFileAll={fileAll}
                  onSelect={editor.select}
                />
              )}
            </>
          )}
          {item !== undefined && isEditable(item) && (
            <FindingFields
              key={item.id}
              item={item}
              schema={model.schema}
              disabled={isBusy}
              review={model}
            />
          )}
          <span className="flex-1" />
          <Button
            variant="ghost"
            className="self-start text-muted-foreground"
            disabled={isBusy}
            onClick={onEndReview}
          >
            End Review
          </Button>
        </aside>
      </div>
    </div>
  )
}

/**
 * Where the device goes. Until the page streams it, the slot names the
 * device the Build runs on; Capture sits under it.
 */
function DeviceColumn({
  deviceName,
  refusal,
  onCapture,
}: {
  readonly deviceName: string | undefined
  readonly refusal: ReturnType<typeof captureRefusal>
  readonly onCapture: () => void
}) {
  const button = (
    <Button
      variant="outline"
      className="w-full"
      disabled={refusal !== undefined}
      onClick={onCapture}
    >
      <CameraIcon />
      Capture
      <Kbd>{chords.capture.label}</Kbd>
    </Button>
  )
  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex aspect-[9/19.5] max-h-full min-h-0 items-center justify-center rounded-[2rem] border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
        {deviceName === undefined
          ? "Resume review to run the Build."
          : `The Build is running on ${deviceName} on the Device Host.`}
      </div>
      {refusal === undefined ? (
        button
      ) : (
        <Tooltip>
          <TooltipTrigger render={<span tabIndex={0} className="flex" />}>
            {button}
          </TooltipTrigger>
          <TooltipContent>{refusalHints[refusal]}</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}

/** Why Capture is disabled, for its tooltip. */
const refusalHints: Record<
  NonNullable<ReturnType<typeof captureRefusal>>,
  string
> = {
  reviewPaused: "Resume review to capture.",
  busy: "nitpick is busy. Try again in a moment.",
  labelDraftPending: "Finish the open text label first.",
}

/** The empty pane between Start review and the first capture. */
function CapturePlaceholder({
  isReviewing,
}: {
  readonly isReviewing: boolean
}) {
  return (
    <div className="flex min-h-0 flex-1 justify-center">
      <div className="flex aspect-[9/19.5] max-h-full items-center justify-center rounded-lg border-2 border-dashed bg-muted/30 p-6 text-center text-lg text-muted-foreground">
        {capturePlaceholder(isReviewing, chords.capture.label)}
      </div>
    </div>
  )
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
    <div className="flex flex-1 items-start justify-center pt-12 text-sm text-muted-foreground">
      {image.status === "failed" ? "The capture couldn't be loaded." : ""}
    </div>
  )
}

/**
 * The Figma URL every Finding of the session files under, unless one sets
 * its own (ADR-0003). It has no section label, so its placeholder names the
 * domain term and the scope.
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
      <LinkIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        aria-label="Design Reference for all Findings"
        placeholder="Design Reference (Figma, all Findings)"
        title="A Figma URL filed with every Finding of this session, unless a Finding sets its own."
        className="pl-8"
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
function useSessionChords({
  editor,
  onCapture,
  onFileAll,
}: {
  readonly editor: Editor
  readonly onCapture: () => void
  readonly onFileAll: () => void
}) {
  const latest = useRef({ editor, onCapture, onFileAll })
  useEffect(() => {
    latest.current = { editor, onCapture, onFileAll }
  })

  useEffect(() => {
    function keyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return
      const { editor, onCapture, onFileAll } = latest.current
      const inField = isTextEntry(event.target)
      // Dialogs and popups render outside the page's root.
      const inPopup =
        event.target instanceof Node &&
        event.target !== document.body &&
        !document.getElementById("root")?.contains(event.target)

      if (chords.capture.matches(event)) {
        event.preventDefault()
        if (!inPopup) onCapture()
        return
      }
      if (inPopup) return
      if (chords.fileAll.matches(event)) {
        event.preventDefault()
        onFileAll()
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
        if (editor.escape(false)) event.preventDefault()
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
