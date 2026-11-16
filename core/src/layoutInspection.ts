// Inspect's geometry over a Layout Snapshot (ADR-0015): which element is
// under the pointer, the bands its padding and its children's gaps make, and
// the distances between two elements as Figma measures them. All in screen
// points; the page only scales what these return.
import type { Point } from "./annotation.ts"
import type {
  LayoutElement,
  LayoutFrame,
  LayoutSnapshot,
} from "./layoutSnapshot.ts"

/** Below this, two edges are the same edge: frames carry 1/3 pt roundings. */
const sameEdge = 0.01

/**
 * The element under `point`: the last, frontmost, whose frame holds it where
 * no clip trims it.
 */
export function layoutElementAt(
  snapshot: LayoutSnapshot,
  point: Point
): LayoutElement | undefined {
  return snapshot.elements.findLast(
    ({ frame, clip }) =>
      holds(frame, point) && (clip === undefined || holds(clip, point))
  )
}

function holds(frame: LayoutFrame, { x, y }: Point): boolean {
  return (
    x >= frame.x &&
    x <= frame.x + frame.width &&
    y >= frame.y &&
    y <= frame.y + frame.height
  )
}

/** Space the overlay hatches, and its size in points along its axis. */
export interface LayoutBand {
  readonly frame: LayoutFrame
  readonly value: number
}

/**
 * The element's padding as four bands inside its frame: top and bottom
 * across its width, leading and trailing between them, as Figma draws it.
 * Leading is the left in a left-to-right language. A side with no padding
 * has no band.
 */
export function paddingBands(element: LayoutElement): LayoutBand[] {
  const { padding, frame } = element
  if (padding === undefined) return []
  const { x, y, width, height } = frame
  const middle = height - padding.top - padding.bottom
  const bands: LayoutBand[] = [
    { frame: { x, y, width, height: padding.top }, value: padding.top },
    {
      frame: {
        x,
        y: y + height - padding.bottom,
        width,
        height: padding.bottom,
      },
      value: padding.bottom,
    },
    {
      frame: { x, y: y + padding.top, width: padding.leading, height: middle },
      value: padding.leading,
    },
    {
      frame: {
        x: x + width - padding.trailing,
        y: y + padding.top,
        width: padding.trailing,
        height: middle,
      },
      value: padding.trailing,
    },
  ]
  return bands.filter(
    (band) =>
      band.value > sameEdge && band.frame.width > 0 && band.frame.height > 0
  )
}

/**
 * The gaps between the element's children, where it declares a stack's or a
 * grid's spacing. Each gap's value is the space measured between the two
 * children, which is the declared spacing unless something, such as a
 * Spacer, sits between them. A stack's gaps span its frame across its axis;
 * a grid's column gaps span their row, and its row gaps the grid's width.
 */
export function spacingGaps(
  snapshot: LayoutSnapshot,
  element: LayoutElement
): LayoutBand[] {
  if (element.spacing === undefined && element.gridSpacing === undefined) {
    return []
  }
  const children = snapshot.elements
    .filter((child) => child.parent === element.id)
    .map((child) => child.frame)
    .filter((frame) => frame.width > 0 && frame.height > 0)
  const { frame } = element
  if (element.spacing?.axis === "horizontal") {
    return gapsAlong("x", children, { from: frame.y, to: bottom(frame) })
  }
  if (element.spacing?.axis === "vertical") {
    return gapsAlong("y", children, { from: frame.x, to: right(frame) })
  }
  const rows = gridRows(children)
  const columnGaps = rows.flatMap((row) =>
    gapsAlong("x", row, {
      from: Math.min(...row.map((cell) => cell.y)),
      to: Math.max(...row.map(bottom)),
    })
  )
  const rowSpans = rows.map((row) => ({
    x: frame.x,
    y: Math.min(...row.map((cell) => cell.y)),
    width: frame.width,
    height:
      Math.max(...row.map(bottom)) - Math.min(...row.map((cell) => cell.y)),
  }))
  return [
    ...columnGaps,
    ...gapsAlong("y", rowSpans, { from: frame.x, to: right(frame) }),
  ]
}

/**
 * The gaps between frames laid out along an axis, each spanning `across` on
 * the other. Frames that overlap leave no gap.
 */
function gapsAlong(
  axis: "x" | "y",
  frames: ReadonlyArray<LayoutFrame>,
  across: { readonly from: number; readonly to: number }
): LayoutBand[] {
  const start = (frame: LayoutFrame) => (axis === "x" ? frame.x : frame.y)
  const end = (frame: LayoutFrame) =>
    axis === "x" ? right(frame) : bottom(frame)
  const sorted = frames.toSorted((a, b) => start(a) - start(b))
  const gaps: LayoutBand[] = []
  let reached = -Infinity
  for (const frame of sorted) {
    const gap = start(frame) - reached
    if (Number.isFinite(gap) && gap > sameEdge) {
      gaps.push({
        frame:
          axis === "x"
            ? {
                x: reached,
                y: across.from,
                width: gap,
                height: across.to - across.from,
              }
            : {
                x: across.from,
                y: reached,
                width: across.to - across.from,
                height: gap,
              },
        value: gap,
      })
    }
    reached = Math.max(reached, end(frame))
  }
  return gaps
}

/** A grid's cells in rows, top to bottom: cells whose heights overlap. */
function gridRows(cells: ReadonlyArray<LayoutFrame>): LayoutFrame[][] {
  const rows: LayoutFrame[][] = []
  let rowBottom = -Infinity
  for (const cell of cells.toSorted((a, b) => a.y - b.y)) {
    if (rows.length > 0 && cell.y < rowBottom - sameEdge) {
      rows.at(-1)!.push(cell)
      rowBottom = Math.max(rowBottom, bottom(cell))
    } else {
      rows.push([cell])
      rowBottom = bottom(cell)
    }
  }
  return rows
}

/**
 * One of the distances between two elements: a line from one edge to the
 * other, with its length in points. When the line runs beside the hovered
 * element rather than into it, `guide` extends that element's edge to the
 * line, dashed.
 */
export interface LayoutMeasurement {
  readonly axis: "horizontal" | "vertical"
  readonly from: Point
  readonly to: Point
  readonly value: number
  readonly guide?: { readonly from: Point; readonly to: Point }
}

/**
 * The distances from the selected element to the hovered one, as Figma
 * shows them: apart on an axis, the space between their facing edges; on an
 * axis where they overlap, as when one holds the other, the space between
 * each pair of edges that differ. Lines run through the middle of where the
 * two overlap on the other axis, or else through the selected element's
 * middle.
 */
export function layoutDistances(
  selected: LayoutFrame,
  hovered: LayoutFrame
): LayoutMeasurement[] {
  return [
    ...distancesAlong("horizontal", selected, hovered),
    ...distancesAlong("vertical", selected, hovered),
  ]
}

function distancesAlong(
  axis: "horizontal" | "vertical",
  selected: LayoutFrame,
  hovered: LayoutFrame
): LayoutMeasurement[] {
  // Spans along the axis, and across it, of each frame.
  const span = (frame: LayoutFrame) =>
    axis === "horizontal"
      ? { start: frame.x, end: right(frame) }
      : { start: frame.y, end: bottom(frame) }
  const spanAcross = (frame: LayoutFrame) =>
    axis === "horizontal"
      ? { start: frame.y, end: bottom(frame) }
      : { start: frame.x, end: right(frame) }
  const a = span(selected)
  const b = span(hovered)
  const acrossA = spanAcross(selected)
  const acrossB = spanAcross(hovered)
  const overlapStart = Math.max(acrossA.start, acrossB.start)
  const overlapEnd = Math.min(acrossA.end, acrossB.end)
  const at =
    overlapEnd >= overlapStart
      ? (overlapStart + overlapEnd) / 2
      : (acrossA.start + acrossA.end) / 2
  const point = (along: number, across: number): Point =>
    axis === "horizontal" ? { x: along, y: across } : { x: across, y: along }

  /** A line from `start` to `end`, `edge` being the hovered element's end. */
  function line(start: number, end: number, edge: number): LayoutMeasurement {
    const reach = Math.min(Math.max(at, acrossB.start), acrossB.end)
    return {
      axis,
      from: point(start, at),
      to: point(end, at),
      value: end - start,
      ...(Math.abs(reach - at) > sameEdge && {
        guide: { from: point(edge, reach), to: point(edge, at) },
      }),
    }
  }

  // Touching edges are 0 apart, which needs no line.
  if (b.start >= a.end - sameEdge) {
    return b.start - a.end > sameEdge ? [line(a.end, b.start, b.start)] : []
  }
  if (b.end <= a.start + sameEdge) {
    return a.start - b.end > sameEdge ? [line(b.end, a.start, b.end)] : []
  }
  const lines: LayoutMeasurement[] = []
  for (const [mine, theirs] of [
    [a.start, b.start],
    [a.end, b.end],
  ] as const) {
    if (Math.abs(mine - theirs) > sameEdge) {
      lines.push(line(Math.min(mine, theirs), Math.max(mine, theirs), theirs))
    }
  }
  return lines
}

function right(frame: LayoutFrame): number {
  return frame.x + frame.width
}

function bottom(frame: LayoutFrame): number {
  return frame.y + frame.height
}

/**
 * A value in points as Inspect writes it: at most two decimals, none when
 * whole. "16", "35.67", "0.4".
 */
export function formatPoints(value: number): string {
  const rounded = Math.round(value * 100) / 100
  return String(rounded === 0 ? 0 : rounded)
}
