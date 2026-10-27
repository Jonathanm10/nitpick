import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import {
  annotationCSSColor,
  annotationMetrics,
  boundingRect,
  drawAnnotation,
  drawAnnotations,
  labelFont,
  trimWhitespaceAndNewlines,
  type Annotation,
  type AnnotationMetrics,
  type Point,
  type Size,
} from "@nitpick/core"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import type { Editor } from "@/lib/use-editor"

const noAnnotations: ReadonlyArray<Annotation> = []

/**
 * Measures label text for hit tests and the selection outline. Any canvas
 * measures alike, so this one needs no mounted surface.
 */
const measurer = document.createElement("canvas").getContext("2d")!

/** The arrow keys as unit steps in image pixels, origin top-left. */
const nudges: Record<string, { dx: number; dy: number }> = {
  ArrowUp: { dx: 0, dy: -1 },
  ArrowDown: { dx: 0, dy: 1 },
  ArrowLeft: { dx: -1, dy: 0 },
  ArrowRight: { dx: 1, dy: 0 },
}

/** The Select tool's gesture, decided at the first pointer movement. */
interface Gesture {
  readonly start: Point
  readonly client: { readonly x: number; readonly y: number }
  mode: "undecided" | "moving" | "rejected"
}

/**
 * The Annotation surface, after Sources/Nitpick/AnnotationSurface.swift: the
 * capture at native pixels with its Annotations drawn by core/'s
 * drawAnnotations, the code the server flattens with, so the preview is the
 * filed image. The canvas is scaled to fit by CSS only. The view holds only
 * the gesture in flight; every committed edit is an Editor call.
 *
 * Without `editable` it shows a frozen Finding: the same image, no edits.
 */
export function AnnotationSurface({
  editor,
  image,
  editable,
}: {
  readonly editor: Editor
  readonly image: HTMLImageElement
  readonly editable: boolean
}) {
  const size: Size = { width: image.naturalWidth, height: image.naturalHeight }
  const metrics = useMemo(
    () => annotationMetrics({ width: size.width, height: size.height }),
    [size.width, size.height]
  )
  const annotations = editor.item?.finding.annotations ?? noAnnotations

  const areaRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const baseRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const [area, setArea] = useState<Size>({ width: 0, height: 0 })
  const [draft, setDraft] = useState<Annotation>()
  const gesture = useRef<Gesture>(undefined)
  /** A text label being typed, before it becomes an Annotation. */
  const [label, setLabelState] = useState<{ at: Point; text: string }>()
  const labelRef = useRef(label)
  const [menuIndex, setMenuIndex] = useState<number>()
  const contextPoint = useRef<Point>(undefined)

  function setLabel(next: { at: Point; text: string } | undefined) {
    labelRef.current = next
    setLabelState(next)
  }

  const scale =
    area.width > 0 && area.height > 0
      ? Math.min(area.width / size.width, area.height / size.height)
      : 0
  const dragIndex =
    editor.selection?.drag === undefined ? undefined : editor.selection.index

  // The area the capture fits into.
  useLayoutEffect(() => {
    const element = areaRef.current
    if (element === null) return
    const observer = new ResizeObserver(([entry]) => {
      setArea({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Keyed by the Editor's generation, so a new target or capture starts
  // clean; it takes key focus.
  useEffect(() => {
    surfaceRef.current?.focus({ preventScroll: true })
  }, [])

  // The Editor refuses to retarget, and capture to start, while a placed
  // label is open: its commit would land on the wrong Finding.
  const { setPendingLabelDraft } = editor
  useEffect(() => {
    setPendingLabelDraft(label !== undefined)
  }, [label, setPendingLabelDraft])

  // The capture with every committed Annotation, the dragged one excepted.
  useLayoutEffect(() => {
    const context = baseRef.current?.getContext("2d")
    if (!context) return
    context.clearRect(0, 0, size.width, size.height)
    context.drawImage(image, 0, 0)
    drawAnnotations(
      context,
      annotations.filter((_, index) => index !== dragIndex),
      metrics
    )
  }, [image, annotations, dragIndex, size.width, size.height, metrics])

  // The shape in flight, and the dragged one at its whole-pixel offset.
  const drag = editor.selection?.drag
  useLayoutEffect(() => {
    const context = overlayRef.current?.getContext("2d")
    if (!context) return
    context.clearRect(0, 0, size.width, size.height)
    if (drag !== undefined) {
      drawAnnotation(
        context,
        editor.displayedSelection ?? drag.annotation,
        metrics
      )
    }
    if (draft !== undefined) drawAnnotation(context, draft, metrics)
  }, [draft, drag, editor.displayedSelection, size.width, size.height, metrics])

  /** A pointer position in image pixels, clamped to the capture. */
  function pixelPoint(event: { clientX: number; clientY: number }): Point {
    const bounds = overlayRef.current!.getBoundingClientRect()
    const clamp = (value: number, limit: number) =>
      Math.min(Math.max(value, 0), limit)
    return {
      x: clamp(
        ((event.clientX - bounds.left) / bounds.width) * size.width,
        size.width
      ),
      y: clamp(
        ((event.clientY - bounds.top) / bounds.height) * size.height,
        size.height
      ),
    }
  }

  function commitLabel() {
    const open = labelRef.current
    if (open === undefined) return
    setLabel(undefined)
    const text = trimWhitespaceAndNewlines(open.text)
    if (text !== "") {
      editor.add({ kind: "label", color: editor.color, text, at: open.at })
    }
  }

  function pointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0 || !editable || !editor.canEdit) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const start = pixelPoint(event)
    gesture.current = {
      start,
      client: { x: event.clientX, y: event.clientY },
      mode: "undecided",
    }
    const color = editor.color
    switch (editor.tool) {
      case "pen":
        setDraft({ kind: "pen", color, points: [start, start] })
        break
      case "arrow":
        setDraft({ kind: "arrow", color, from: start, to: start })
        break
      case "rectangle":
        setDraft({ kind: "rectangle", color, rect: rectFrom(start, start) })
        break
    }
  }

  function pointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const current = gesture.current
    if (current === undefined) return
    const point = pixelPoint(event)
    switch (editor.tool) {
      case "pen":
        setDraft((shape) =>
          shape?.kind === "pen"
            ? { ...shape, points: [...shape.points, point] }
            : shape
        )
        break
      case "arrow":
        setDraft((shape) =>
          shape?.kind === "arrow" ? { ...shape, to: point } : shape
        )
        break
      case "rectangle":
        setDraft((shape) =>
          shape?.kind === "rectangle"
            ? { ...shape, rect: rectFrom(current.start, point) }
            : shape
        )
        break
      case "select": {
        // A hair of travel tells a drag from a click; a move starts only
        // on the selected shape.
        const offset = {
          dx: point.x - current.start.x,
          dy: point.y - current.start.y,
        }
        if (current.mode === "undecided") {
          const travel = Math.hypot(
            event.clientX - current.client.x,
            event.clientY - current.client.y
          )
          if (travel < 2) break
          current.mode = editor.beginDrag(current.start, metrics, measurer)
            ? "moving"
            : "rejected"
        }
        if (current.mode === "moving") editor.updateDrag(offset)
        break
      }
    }
  }

  function pointerUp(event: React.PointerEvent<HTMLCanvasElement>) {
    const current = gesture.current
    if (current === undefined) return
    gesture.current = undefined
    const point = pixelPoint(event)
    switch (editor.tool) {
      case "select": {
        // A move commits whole, one undo step; anything else is the click
        // at the press point, so a drag from empty surface selects nothing.
        if (current.mode === "moving") {
          editor.endDrag()
        } else {
          editor.selectAt(current.start, metrics, measurer)
        }
        surfaceRef.current?.focus({ preventScroll: true })
        break
      }
      case "label":
        // An open label commits before the next one opens: typed text is
        // never silently dropped.
        commitLabel()
        setLabel({ at: point, text: "" })
        break
      default:
        setDraft(undefined)
        if (draft !== undefined && drawsSomething(draft)) editor.add(draft)
    }
  }

  function pointerCancel() {
    if (gesture.current?.mode === "moving") editor.cancelDrag()
    gesture.current = undefined
    setDraft(undefined)
  }

  function keyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    // The label editor keeps its own keys.
    if (event.target !== event.currentTarget || !editable) return
    const nudge = nudges[event.key]
    if (
      nudge !== undefined &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      // Consumed even with nothing selected, so an idle arrow never scrolls.
      event.preventDefault()
      editor.nudge(nudge, event.shiftKey ? 5 : 1, metrics.strokeWidth)
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault()
      editor.deleteSelected()
    } else if (event.key === "Escape" && editor.escape(true)) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  const selectionBounds = selectionOutline(editor, metrics)

  return (
    <div ref={areaRef} className="relative min-h-0 w-full flex-1">
      <ContextMenu
        open={menuIndex !== undefined}
        onOpenChange={(open) => {
          // Right-click offers Delete on a committed Annotation under any
          // tool, and nothing on empty surface.
          if (!open) {
            setMenuIndex(undefined)
            return
          }
          const point = contextPoint.current
          if (!editable || !editor.canEdit || point === undefined) return
          setMenuIndex(editor.indexAt(point, metrics, measurer))
        }}
      >
        <ContextMenuTrigger
          render={
            <div
              ref={surfaceRef}
              tabIndex={0}
              role="group"
              aria-label="Capture"
              aria-roledescription="annotation surface"
              onKeyDown={keyDown}
              onContextMenuCapture={(event) => {
                contextPoint.current = pixelPoint(event)
              }}
              className="absolute top-0 left-1/2 -translate-x-1/2 overflow-hidden rounded-lg shadow-lg ring-1 ring-foreground/10 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              style={{
                width: size.width * scale,
                height: size.height * scale,
              }}
            />
          }
        >
          <canvas
            ref={baseRef}
            width={size.width}
            height={size.height}
            className="absolute inset-0 size-full"
            data-testid="annotated-capture"
          />
          <canvas
            ref={overlayRef}
            width={size.width}
            height={size.height}
            className="absolute inset-0 size-full touch-none"
            style={{ cursor: editable ? cursorFor(editor.tool) : "default" }}
            onPointerDown={pointerDown}
            onPointerMove={pointerMove}
            onPointerUp={pointerUp}
            onPointerCancel={pointerCancel}
          />
          {selectionBounds !== undefined && (
            // Workspace chrome at view scale: it never reaches a canvas,
            // so it can never be filed.
            <div
              aria-hidden
              className="pointer-events-none absolute rounded border-[1.5px] border-dashed border-blue-500"
              style={{
                left: selectionBounds.x * scale,
                top: selectionBounds.y * scale,
                width: selectionBounds.width * scale,
                height: selectionBounds.height * scale,
              }}
            />
          )}
          {label !== undefined && (
            <input
              key={`${label.at.x},${label.at.y}`}
              autoFocus
              aria-label="Text label"
              placeholder="Note"
              value={label.text}
              onChange={(event) =>
                setLabel({ at: label.at, text: event.target.value })
              }
              // Return and Esc are the label's; the page's chords still run,
              // and refuse what an open label blocks.
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  commitLabel()
                  surfaceRef.current?.focus({ preventScroll: true })
                } else if (event.key === "Escape") {
                  event.preventDefault()
                  setLabel(undefined)
                  surfaceRef.current?.focus({ preventScroll: true })
                }
              }}
              // Losing focus commits: the Reviewer saw the typed text.
              onBlur={commitLabel}
              className="absolute w-56 border-0 bg-transparent p-0 outline-none placeholder:text-current placeholder:opacity-50"
              style={{
                left: label.at.x * scale,
                top: label.at.y * scale,
                font: labelFont({
                  ...metrics,
                  fontSize: metrics.fontSize * scale,
                }),
                color: annotationCSSColor(editor.color),
              }}
            />
          )}
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            variant="destructive"
            onClick={() => {
              if (menuIndex !== undefined) editor.deleteAt(menuIndex)
            }}
          >
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  )
}

/** The dashed outline around the selection's drawn bounds, padded. */
function selectionOutline(editor: Editor, metrics: AnnotationMetrics) {
  const annotation = editor.displayedSelection
  if (annotation === undefined) return undefined
  const bounds = boundingRect(annotation, metrics, measurer)
  if (bounds === undefined) return undefined
  const padding = metrics.strokeWidth
  return {
    x: bounds.x - padding,
    y: bounds.y - padding,
    width: bounds.width + 2 * padding,
    height: bounds.height + 2 * padding,
  }
}

function rectFrom(start: Point, end: Point) {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  }
}

/**
 * A click without a drag leaves no arrow or rectangle: a zero-length arrow
 * or an empty rectangle would draw nothing, yet still be selectable.
 */
function drawsSomething(annotation: Annotation): boolean {
  switch (annotation.kind) {
    case "arrow":
      return (
        annotation.from.x !== annotation.to.x ||
        annotation.from.y !== annotation.to.y
      )
    case "rectangle":
      return annotation.rect.width > 0 || annotation.rect.height > 0
    default:
      return true
  }
}

function cursorFor(tool: Editor["tool"]): string {
  switch (tool) {
    case "select":
      return "default"
    case "label":
      return "text"
    default:
      return "crosshair"
  }
}
