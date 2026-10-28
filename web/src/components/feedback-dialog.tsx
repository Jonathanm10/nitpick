import { useEffect, useMemo, useRef, useState } from "react"
import {
  annotationMetrics,
  browserDescription,
  environmentLines,
  feedbackHasText,
  feedbackSummary,
  webFeedbackEnvironment,
  type Annotation,
  type FeedbackEnvironment,
  type FeedbackKind,
  type FeedbackReviewContext,
  type SentFeedback,
  type TrayItem,
} from "@nitpick/core"
import {
  CircleCheckIcon,
  ImageIcon,
  MessageSquareIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { AnnotationSurface } from "@/components/annotation-surface"
import {
  annotationTools,
  AnnotationToolbar,
} from "@/components/annotation-toolbar"
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { api } from "@/lib/api"
import { chords, isApplePlatform, isTextEntry } from "@/lib/chords"
import { drawPreview } from "@/lib/label-sprites"
import { useCaptureImage } from "@/lib/use-capture-image"
import { useEditor } from "@/lib/use-editor"

type Phase =
  | { readonly phase: "editing" }
  | { readonly phase: "sending" }
  | { readonly phase: "sent"; readonly sent: SentFeedback }
  | { readonly phase: "failed"; readonly message: string }

/** The attached image, as a one-Finding Tray the Editor can annotate. */
const imageItemID = "feedback-image"

const kindLabels: Record<FeedbackKind, string> = {
  bug: "Bug",
  improvement: "Improvement",
}

/**
 * "Send feedback" in the page header and its dialog, after
 * Sources/Nitpick/FeedbackSheet.swift: kind, title and description, the
 * read-only Environment, an image attached by paste or file pick and
 * annotated with the Editor's own surface and toolbar, the discard
 * confirmation, and the sent state. Every opening starts blank. Sending is
 * not a run: the review behind the dialog never freezes.
 */
export function FeedbackButton({
  review,
}: {
  /** The open Review Session's Build and device, for the Environment. */
  readonly review: FeedbackReviewContext | undefined
}) {
  const [opening, setOpening] = useState(0)
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setOpening((count) => count + 1)
          setOpen(true)
        }}
      >
        <MessageSquareIcon />
        Send feedback
      </Button>
      {open && (
        <FeedbackDialog
          key={opening}
          review={review}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

function FeedbackDialog({
  review,
  onClose,
}: {
  readonly review: FeedbackReviewContext | undefined
  readonly onClose: () => void
}) {
  const [phase, setPhase] = useState<Phase>({ phase: "editing" })
  const [kind, setKind] = useState<FeedbackKind>("bug")
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [image, setImage] = useState<{ blob: Blob; url: string }>()
  const [annotations, setAnnotations] = useState<ReadonlyArray<Annotation>>([])
  const [annotating, setAnnotating] = useState(false)
  const [confirmsDiscard, setConfirmsDiscard] = useState(false)
  const [imageError, setImageError] = useState<string>()
  const environment = useEnvironment(review)

  const editable = phase.phase === "editing" || phase.phase === "failed"
  const feedback = {
    kind,
    title,
    description,
    environment: environment ?? {},
  }
  const canSend =
    editable && environment !== undefined && feedbackSummary(feedback) !== ""
  const closeNeedsConfirmation =
    editable && (feedbackHasText(feedback) || annotations.length > 0)

  // The object URL lives as long as its image is attached.
  useEffect(() => {
    if (image === undefined) return
    return () => URL.revokeObjectURL(image.url)
  }, [image])

  function attach(blob: Blob) {
    if (!["image/png", "image/jpeg"].includes(blob.type)) {
      setImageError("Attach a PNG or JPEG image.")
      return
    }
    setImageError(undefined)
    setAnnotations([])
    setImage({ blob, url: URL.createObjectURL(blob) })
  }

  function requestClose() {
    if (closeNeedsConfirmation) setConfirmsDiscard(true)
    else onClose()
  }

  async function send() {
    if (!canSend || environment === undefined) return
    setPhase({ phase: "sending" })
    try {
      const { sent } = await api.sendFeedback(
        {
          kind,
          title,
          description,
          environment,
          imageAnnotations: image === undefined ? undefined : annotations,
        },
        image?.blob
      )
      setPhase({ phase: "sent", sent })
    } catch (error) {
      setPhase({
        phase: "failed",
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next, details) => {
        if (next) return
        // Esc while annotating goes back to the form, unless a text label
        // is open: the label's own Esc cancels it.
        if (annotating) {
          if (details.reason !== "escape-key") return
          const target = details.event?.target
          if (!isTextEntry(target ?? null)) setAnnotating(false)
          return
        }
        if (phase.phase !== "sending") requestClose()
      }}
    >
      <DialogContent
        showCloseButton={!annotating}
        className={
          annotating
            ? "flex h-[calc(100svh-4rem)] flex-col sm:max-w-[min(72rem,calc(100%-4rem))]"
            : "sm:max-w-lg"
        }
        onPaste={(event) => {
          if (!editable || annotating) return
          const files = [...event.clipboardData.files].filter((file) =>
            file.type.startsWith("image/")
          )
          // A text field keeps a text paste; an image alone attaches.
          if (
            files.length === 0 ||
            (isTextEntry(event.target) &&
              event.clipboardData.types.includes("text/plain"))
          ) {
            return
          }
          event.preventDefault()
          attach(files[0])
        }}
      >
        {annotating && image !== undefined ? (
          <Annotating
            imageURL={image.url}
            annotations={annotations}
            onChange={setAnnotations}
            onDone={() => setAnnotating(false)}
          />
        ) : phase.phase === "sent" ? (
          <Sent sent={phase.sent} onDone={onClose} />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Send feedback</DialogTitle>
            </DialogHeader>
            <fieldset
              disabled={!editable}
              className="flex min-w-0 flex-col gap-3"
            >
              <ToggleGroup
                aria-label="Kind"
                variant="outline"
                spacing={0}
                value={[kind]}
                onValueChange={(value) => {
                  const [next] = value as FeedbackKind[]
                  if (next !== undefined) setKind(next)
                }}
                className="self-start"
              >
                {(["bug", "improvement"] as const).map((value) => (
                  <ToggleGroupItem key={value} value={value}>
                    {kindLabels[value]}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="feedback-title" className={sectionLabel}>
                  Title
                </Label>
                <Input
                  id="feedback-title"
                  autoFocus
                  placeholder="What happened, or what should change?"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="feedback-description" className={sectionLabel}>
                  Description
                </Label>
                <Textarea
                  id="feedback-description"
                  rows={4}
                  className="max-h-40"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </div>
              <EnvironmentBlock environment={environment} />
              <ImageField
                imageURL={image?.url}
                annotations={annotations}
                error={imageError}
                onChoose={attach}
                onAnnotate={() => setAnnotating(true)}
                onRemove={() => {
                  setImage(undefined)
                  setAnnotations([])
                }}
              />
            </fieldset>
            {phase.phase === "failed" && (
              <p role="alert" className="text-sm text-destructive select-text">
                {phase.message}
              </p>
            )}
            <DialogFooter className="items-center">
              {phase.phase === "sending" && (
                <span className="mr-auto flex items-center gap-2 text-muted-foreground">
                  <Spinner />
                  Sending…
                </span>
              )}
              <Button
                variant="outline"
                disabled={!editable}
                onClick={requestClose}
              >
                Cancel
              </Button>
              <Button disabled={!canSend} onClick={() => void send()}>
                Send
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>

      <AlertDialog open={confirmsDiscard} onOpenChange={setConfirmsDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard feedback?</AlertDialogTitle>
            <AlertDialogDescription>
              What you wrote and drew will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep Editing</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onClose}>
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  )
}

const sectionLabel = "text-xs font-medium text-muted-foreground uppercase"

/**
 * The Environment, read once as the dialog opens, as Swift read it: this
 * page's build and browser, then the server's version and the Device
 * Host's macOS and Xcode. What the server can't say is "unknown".
 */
function useEnvironment(
  review: FeedbackReviewContext | undefined
): FeedbackEnvironment | undefined {
  const [environment, setEnvironment] = useState<FeedbackEnvironment>()
  const reviewAtOpening = useRef(review)
  useEffect(() => {
    let current = true
    const page = {
      webApp: __NITPICK_VERSION__,
      browser: browserDescription(navigator.userAgent),
      review: reviewAtOpening.current,
    }
    api
      .feedbackEnvironment()
      .then(
        ({ server, deviceHost }) =>
          webFeedbackEnvironment({
            ...page,
            server,
            deviceHostMacOS: deviceHost.macOS,
            deviceHostXcode: deviceHost.xcode,
          }),
        () => webFeedbackEnvironment(page)
      )
      .then((read) => {
        if (current) setEnvironment(read)
      })
    return () => {
      current = false
    }
  }, [])
  return environment
}

function EnvironmentBlock({
  environment,
}: {
  readonly environment: FeedbackEnvironment | undefined
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className={sectionLabel}>Environment</span>
      <ul className="flex min-h-24 flex-col gap-0.5 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground select-text">
        {environment === undefined ? (
          <li className="flex items-center gap-2">
            <Spinner />
            Reading the versions…
          </li>
        ) : (
          environmentLines(environment).map(({ label, value }) => (
            <li key={label}>
              • {label}: {value}
            </li>
          ))
        )}
      </ul>
    </div>
  )
}

/**
 * Where the image goes: paste one, or choose a file. A page can't
 * screenshot itself without the browser's screen-share prompt, so the
 * Reviewer brings the image (parity.md, Feedback).
 */
function ImageField({
  imageURL,
  annotations,
  error,
  onChoose,
  onAnnotate,
  onRemove,
}: {
  readonly imageURL: string | undefined
  readonly annotations: ReadonlyArray<Annotation>
  readonly error: string | undefined
  readonly onChoose: (file: File) => void
  readonly onAnnotate: () => void
  readonly onRemove: () => void
}) {
  const picker = useRef<HTMLInputElement>(null)
  const paste = isApplePlatform ? "⌘V" : "Ctrl+V"
  const annotationCount = annotations.length
  return (
    <div className="flex flex-col gap-1.5">
      <span className={sectionLabel}>Image</span>
      <input
        ref={picker}
        type="file"
        accept="image/png,image/jpeg"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file !== undefined) onChoose(file)
          event.target.value = ""
        }}
      />
      {imageURL === undefined ? (
        <div className="flex items-center gap-3 rounded-lg border border-dashed px-3 py-3 text-sm text-muted-foreground">
          <ImageIcon className="size-4 shrink-0" aria-hidden />
          <span className="flex-1">
            Paste an image ({paste}) or choose one.
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => picker.current?.click()}
          >
            Choose image…
          </Button>
        </div>
      ) : (
        <div className="flex items-start gap-3">
          <button
            type="button"
            title="Annotate the image"
            aria-label="Preview of the attached image"
            onClick={onAnnotate}
            className="overflow-hidden rounded-md ring-1 ring-foreground/10"
          >
            <AnnotatedPreview url={imageURL} annotations={annotations} />
          </button>
          <div className="flex flex-col items-start gap-1.5">
            <Button variant="outline" size="sm" onClick={onAnnotate}>
              Annotate…
            </Button>
            <span className="text-xs text-muted-foreground">
              {annotationCount === 0
                ? "Point at what you mean."
                : annotationCount === 1
                  ? "1 annotation"
                  : `${annotationCount} annotations`}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={onRemove}
            >
              Remove image
            </Button>
          </div>
        </div>
      )}
      {error !== undefined && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

/** The thumbnail, with the marks drawn as they will be sent. */
function AnnotatedPreview({
  url,
  annotations,
}: {
  readonly url: string
  readonly annotations: ReadonlyArray<Annotation>
}) {
  const image = useCaptureImage(url)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [sprites, setSprites] = useState(0)
  const loaded = image.status === "loaded" ? image.image : undefined
  useEffect(() => {
    const context = canvas.current?.getContext("2d")
    if (loaded === undefined || !context) return
    const size = { width: loaded.naturalWidth, height: loaded.naturalHeight }
    context.clearRect(0, 0, size.width, size.height)
    context.drawImage(loaded, 0, 0)
    drawPreview(context, annotations, annotationMetrics(size), () =>
      setSprites((count) => count + 1)
    )
  }, [loaded, annotations, sprites])
  if (loaded === undefined) return <div className="h-24 w-36 bg-muted" />
  return (
    <canvas
      ref={canvas}
      width={loaded.naturalWidth}
      height={loaded.naturalHeight}
      className="block max-h-36 max-w-56"
      data-testid="feedback-image-preview"
    />
  )
}

/**
 * The image under the Editor's own toolbar and surface, the code that
 * annotates Findings, at most of the window's size. The marks are drawn
 * into the image when it is sent.
 */
function Annotating({
  imageURL,
  annotations,
  onChange,
  onDone,
}: {
  readonly imageURL: string
  readonly annotations: ReadonlyArray<Annotation>
  readonly onChange: (annotations: ReadonlyArray<Annotation>) => void
  readonly onDone: () => void
}) {
  const image = useCaptureImage(imageURL)
  const tray = useMemo<ReadonlyArray<TrayItem>>(
    () => [
      {
        id: imageItemID,
        finding: {
          summary: "",
          description: "",
          deviceContext: {
            deviceModel: "",
            osName: "",
            accessibilitySettings: [],
          },
          annotations,
          designSnapshots: [],
          type: "bug",
        },
        filingProgress: { state: "notStarted" },
      },
    ],
    [annotations]
  )
  const editor = useEditor({
    session: { tray },
    isBusy: false,
    onAnnotations: (_, next) => onChange(next),
    // Esc on an image without marks leaves, as Esc does with marks.
    onDiscard: onDone,
  })
  // The Editor opens on the image once, as a capture opens on a Finding.
  const opened = useRef(false)
  useEffect(() => {
    if (opened.current) return
    opened.current = true
    editor.open(imageItemID)
  })

  // The page's chords stop at dialogs, so the tools' own keys live here,
  // on the document: focus may sit on the dialog itself, not the surface.
  const latest = useRef(editor)
  useEffect(() => {
    latest.current = editor
  })
  useEffect(() => {
    function keyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return
      const editor = latest.current
      const inField = isTextEntry(event.target)
      if (chords.undo.matches(event) || chords.redo.matches(event)) {
        if (inField) return
        event.preventDefault()
        if (chords.undo.matches(event)) editor.undo()
        else editor.redo()
        return
      }
      if (
        inField ||
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

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <DialogHeader>
        <DialogTitle>Annotate image</DialogTitle>
      </DialogHeader>
      <AnnotationToolbar editor={editor} />
      <div className="flex min-h-0 flex-1">
        {image.status === "loaded" && editor.item !== undefined ? (
          <AnnotationSurface
            key={editor.editor.generation}
            editor={editor}
            image={image.image}
            editable
          />
        ) : image.status === "failed" ? (
          <p className="text-sm text-destructive">
            The image can't be read. Attach a PNG or JPEG.
          </p>
        ) : null}
      </div>
      <DialogFooter className="items-center">
        <span className="mr-auto text-muted-foreground">
          Annotations are drawn into the attached image.
        </span>
        {/* A placed label commits on Return; leaving first would drop it. */}
        <Button disabled={editor.editor.hasPendingLabelDraft} onClick={onDone}>
          Done
        </Button>
      </DialogFooter>
    </div>
  )
}

function Sent({
  sent,
  onDone,
}: {
  readonly sent: SentFeedback
  readonly onDone: () => void
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Send feedback</DialogTitle>
      </DialogHeader>
      <div className="flex flex-col gap-3">
        <p className="flex items-center gap-2 font-medium select-text">
          <CircleCheckIcon className="size-4 text-green-600" aria-hidden />
          Sent as {sent.idReadable}
        </p>
        {sent.warnings.map((warning) => (
          <p
            key={warning}
            className="flex items-center gap-2 text-sm text-amber-600"
          >
            <TriangleAlertIcon className="size-4 shrink-0" aria-hidden />
            {warning}
          </p>
        ))}
        <p className="text-muted-foreground">
          Thanks — the nitpick team triages it on the board.
        </p>
      </div>
      <DialogFooter>
        <Button
          variant="outline"
          onClick={() => window.open(sent.url, "_blank", "noreferrer")}
        >
          Open in YouTrack
        </Button>
        <Button autoFocus onClick={onDone}>
          Done
        </Button>
      </DialogFooter>
    </>
  )
}
