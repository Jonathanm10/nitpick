import { useId, useRef } from "react"
import {
  formatPoints,
  layoutDistances,
  layoutElementAt,
  paddingBands,
  spacingGaps,
  type LayoutElement,
  type LayoutFrame,
  type LayoutSnapshot,
} from "@nitpick/core"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { useElementSize, type Size } from "@/lib/stage-layout"
import { shownScreen } from "@/lib/stream-surface"
import type { Inspect } from "@/lib/use-inspect"

/** Figma's colours for the same marks, so a designer reads them at once. */
export const inspectColors = {
  outline: "#0d99ff",
  padding: "#f24e9e",
  gap: "#9747ff",
  distance: "#f24822",
} as const

/**
 * Inspect over the live screen: the hovered or selected element's outline
 * and size, its padding and its children's gaps, and the distances from
 * the selected element to the hovered one. Drawn in the stream's scaled
 * space, labelled in points. It takes the pointer, so the device gets none.
 */
export function InspectOverlay({ inspect }: { readonly inspect: Inspect }) {
  const ref = useRef<HTMLDivElement>(null)
  const size = useElementSize(ref)
  const { reading, snapshot } = inspect

  /** The element under the pointer, in the snapshot's points. */
  function elementAt(event: React.MouseEvent): LayoutElement | undefined {
    if (snapshot === undefined || ref.current === null) return undefined
    const { screen } = snapshot
    const shown = shownScreen(ref.current.getBoundingClientRect(), screen)
    const x = ((event.clientX - shown.left) / shown.width) * screen.width
    const y = ((event.clientY - shown.top) / shown.height) * screen.height
    if (x < 0 || y < 0 || x > screen.width || y > screen.height) {
      return undefined
    }
    return layoutElementAt(snapshot, { x, y })
  }

  return (
    <div
      ref={ref}
      data-inspect-overlay=""
      className="absolute inset-0 cursor-crosshair"
      onPointerMove={(event) => inspect.hover(elementAt(event)?.id)}
      onPointerLeave={() => inspect.hover(undefined)}
      onClick={(event) => inspect.select(elementAt(event)?.id)}
    >
      {snapshot !== undefined && (
        <Marks
          snapshot={snapshot}
          size={size}
          selected={inspect.selected}
          hovered={inspect.hovered}
        />
      )}
      {reading?.status === "reading" && (
        <div className="pointer-events-none absolute inset-x-0 top-[12%] flex justify-center">
          <span className="flex items-center gap-2 rounded-full px-3 py-1.5 text-[12px] text-foreground float-surface">
            <Spinner className="size-3.5" />
            Reading the layout…
          </span>
        </div>
      )}
      {(reading?.status === "unavailable" || reading?.status === "failed") && (
        <div className="absolute inset-0 flex cursor-default items-center justify-center bg-black/55 p-4">
          <div className="flex max-w-[16rem] flex-col items-center gap-3 rounded-xl p-4 text-center text-[12.5px] text-foreground float-surface">
            <p className="font-medium">
              {reading.status === "unavailable"
                ? "Inspect isn't available"
                : "No layout to inspect"}
            </p>
            <p role="alert" className="text-text-2 select-text">
              {reading.status === "unavailable"
                ? reading.reason
                : reading.message}
            </p>
            <div className="flex gap-2">
              {reading.status === "failed" && reading.canRetry && (
                <Button size="sm" variant="secondary" onClick={inspect.refresh}>
                  Try again
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={inspect.leave}>
                Leave Inspect
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** Where the screen shows in an element of `size`, letterboxed. */
function fit(size: Size, screen: Size) {
  const scale = Math.min(size.width / screen.width, size.height / screen.height)
  const width = screen.width * scale
  const height = screen.height * scale
  return {
    left: (size.width - width) / 2,
    top: (size.height - height) / 2,
    width,
    height,
    scale,
  }
}

function Marks({
  snapshot,
  size,
  selected,
  hovered,
}: {
  readonly snapshot: LayoutSnapshot
  readonly size: Size
  readonly selected: LayoutElement | undefined
  readonly hovered: LayoutElement | undefined
}) {
  const id = useId()
  const shown = fit(size, snapshot.screen)
  if (shown.scale <= 0) return null
  const px = (points: number) => points * shown.scale
  const box = (frame: LayoutFrame) => ({
    x: px(frame.x),
    y: px(frame.y),
    width: px(frame.width),
    height: px(frame.height),
  })
  const focus = selected ?? hovered
  const other =
    selected !== undefined && hovered !== undefined && hovered !== selected
      ? hovered
      : undefined
  const distances =
    selected !== undefined && other !== undefined
      ? layoutDistances(selected.frame, other.frame)
      : []
  // While it measures, the selection's own bands would bury the distances.
  const bandsOf = focus !== undefined && other === undefined ? focus : undefined
  const padding = bandsOf === undefined ? [] : paddingBands(bandsOf)
  const gaps = bandsOf === undefined ? [] : spacingGaps(snapshot, bandsOf)
  const labels: Array<{
    key: string
    x: number
    y: number
    text: string
    color: string
  }> = []
  for (const [kind, bands] of [
    ["padding", padding],
    ["gap", gaps],
  ] as const) {
    bands.forEach((band, index) => {
      const { x, y, width, height } = box(band.frame)
      labels.push({
        key: `${kind}${index}`,
        x: x + width / 2,
        y: y + height / 2,
        text: formatPoints(band.value),
        color: inspectColors[kind],
      })
    })
  }
  distances.forEach((distance, index) => {
    labels.push({
      key: `distance${index}`,
      x: px((distance.from.x + distance.to.x) / 2),
      y: px((distance.from.y + distance.to.y) / 2),
      text: formatPoints(distance.value),
      color: inspectColors.distance,
    })
  })
  // While it measures, the inspector has the selection's size.
  if (focus !== undefined && other === undefined) {
    const { x, y, width, height } = box(focus.frame)
    // Under the element, or over it when it reaches the screen's foot.
    const below = y + height + 13
    labels.push({
      key: "size",
      x: x + width / 2,
      y: below < shown.height - 10 ? below : Math.max(10, y - 13),
      text: `${formatPoints(focus.frame.width)} × ${formatPoints(focus.frame.height)}`,
      color: inspectColors.outline,
    })
  }

  return (
    <div
      className="pointer-events-none absolute"
      style={{
        left: shown.left,
        top: shown.top,
        width: shown.width,
        height: shown.height,
      }}
    >
      <svg
        width={shown.width}
        height={shown.height}
        className="absolute inset-0"
        aria-hidden
      >
        <defs>
          {(["padding", "gap"] as const).map((kind) => (
            <pattern
              key={kind}
              id={`${id}${kind}`}
              width="5"
              height="5"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <line
                x1="0"
                y1="0"
                x2="0"
                y2="5"
                stroke={inspectColors[kind]}
                strokeWidth="1.5"
              />
            </pattern>
          ))}
        </defs>
        {(
          [
            ["padding", padding],
            ["gap", gaps],
          ] as const
        ).flatMap(([kind, bands]) =>
          bands.map((band, index) => (
            <g key={`${kind}${index}`}>
              <rect
                {...box(band.frame)}
                fill={inspectColors[kind]}
                fillOpacity={0.14}
              />
              <rect
                {...box(band.frame)}
                fill={`url(#${id}${kind})`}
                opacity={0.7}
              />
            </g>
          ))
        )}
        {other !== undefined && (
          <rect
            {...box(other.frame)}
            fill="none"
            stroke={inspectColors.outline}
            strokeWidth={1}
            strokeDasharray="4 3"
          />
        )}
        {focus !== undefined && (
          <rect
            {...box(focus.frame)}
            fill="none"
            stroke={inspectColors.outline}
            strokeWidth={1.5}
          />
        )}
        {distances.map((distance, index) => {
          const from = { x: px(distance.from.x), y: px(distance.from.y) }
          const to = { x: px(distance.to.x), y: px(distance.to.y) }
          const tick = (point: { x: number; y: number }) =>
            distance.axis === "horizontal"
              ? { x1: point.x, x2: point.x, y1: point.y - 4, y2: point.y + 4 }
              : { x1: point.x - 4, x2: point.x + 4, y1: point.y, y2: point.y }
          return (
            <g key={index} stroke={inspectColors.distance} strokeWidth={1}>
              <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} />
              <line {...tick(from)} />
              <line {...tick(to)} />
              {distance.guide !== undefined && (
                <line
                  x1={px(distance.guide.from.x)}
                  y1={px(distance.guide.from.y)}
                  x2={px(distance.guide.to.x)}
                  y2={px(distance.guide.to.y)}
                  strokeDasharray="3 2"
                />
              )}
            </g>
          )
        })}
      </svg>
      {labels.map((label) => (
        <span
          key={label.key}
          className="absolute -translate-x-1/2 -translate-y-1/2 rounded-[3px] px-1 font-mono text-[10px] leading-[15px] font-medium whitespace-nowrap text-white shadow-[0_1px_3px_rgb(0_0_0/0.35)]"
          style={{ left: label.x, top: label.y, background: label.color }}
        >
          {label.text}
        </span>
      ))}
    </div>
  )
}
