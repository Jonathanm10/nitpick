// Not a port: Inspect is new to the web app (ADR-0015). The frames are the
// ones the server reads from the fictional Acme Store
// (scripts/inspect-sample/AcmeStore.swift) on an iPhone 17 Pro, so every
// spacing and padding below is one that app's source writes.
import { describe, expect, test } from "vitest"
import {
  formatPoints,
  layoutDistances,
  layoutElementAt,
  paddingBands,
  spacingGaps,
  type LayoutElement,
  type LayoutSnapshot,
} from "../src/index.ts"

function element(
  id: string,
  parent: string | undefined,
  name: string,
  [x, y, width, height]: readonly [number, number, number, number],
  values: Partial<LayoutElement> = {}
): LayoutElement {
  return {
    id,
    ...(parent !== undefined && { parent }),
    name,
    frame: { x, y, width, height },
    ...values,
  }
}

// Shop: the screen's VStack(spacing: 16), its first rows, and the first
// product row: .padding(12) around HStack(spacing: 14).
const screenStack = element(
  "stack",
  undefined,
  "VStack",
  [20, 116, 362, 851.33],
  {
    spacing: { axis: "vertical", value: 16 },
  }
)
const title = element("title", "stack", "Text", [20, 116, 182, 35.67])
const blurb = element("blurb", "stack", "Text", [20, 167.67, 324.33, 18])
const banner = element("banner", "stack", "Frame", [20, 201.67, 362, 30.33])
const card = element("card", "stack", "View", [20, 248, 362, 80], {
  padding: { top: 12, leading: 12, bottom: 12, trailing: 12 },
  cornerRadius: 18,
  fill: "#F4F1EA",
})
const row = element("row", "card", "HStack", [32, 260, 338, 56], {
  spacing: { axis: "horizontal", value: 14 },
})
const tile = element("tile", "row", "Frame", [32, 260, 56, 56])
const labels = element(
  "labels",
  "row",
  "VStack",
  [102, 268.67, 110.33, 38.67],
  {
    spacing: { axis: "vertical", value: 4 },
  }
)
const name = element("name", "labels", "Text", [102, 268.67, 110.33, 20.33])
const price = element("price", "labels", "Text", [102, 293, 79.67, 14.33])
const secondCard = element("card2", "stack", "View", [20, 344, 362, 80])
// The cover's AcmeButton(style: .secondary, size: .regular): 14 and 24.
const button = element(
  "button",
  undefined,
  "AcmeButton",
  [119.33, 486.17, 163.33, 47.33],
  {
    padding: { top: 14, leading: 24, bottom: 14, trailing: 24 },
    properties: { style: "secondary", size: "regular" },
  }
)
const buttonLabel = element(
  "label",
  "button",
  "Text",
  [143.33, 500.17, 115.33, 19.33]
)

const shop: LayoutSnapshot = {
  screen: { width: 402, height: 874, scale: 3 },
  elements: [
    screenStack,
    title,
    blurb,
    banner,
    card,
    row,
    tile,
    labels,
    name,
    price,
    secondCard,
    button,
    buttonLabel,
  ],
}

// Browse: LazyVGrid(columns: two flexible with spacing 12, spacing: 16)
// inside .padding(20), its tiles in the order SwiftUI listed them.
const grid = element("grid", undefined, "LazyVGrid", [20, 136, 362, 392], {
  gridSpacing: { horizontal: 12, vertical: 16 },
})
const tiles = [
  [207, 136],
  [20, 136],
  [20, 272],
  [207, 272],
  [20, 408],
  [207, 408],
].map(([x, y], index) =>
  element(`tile${index}`, "grid", "Frame", [x, y, 175, 120], {
    cornerRadius: 20,
  })
)
const browse: LayoutSnapshot = {
  screen: shop.screen,
  elements: [grid, ...tiles],
}

describe("the element under the pointer", () => {
  test("is the frontmost one whose frame holds the point", () => {
    expect(layoutElementAt(shop, { x: 150, y: 280 })).toBe(name)
    expect(layoutElementAt(shop, { x: 150, y: 300 })).toBe(price)
    // In the row's 12 pt padding: the card, not its row.
    expect(layoutElementAt(shop, { x: 25, y: 300 })).toBe(card)
    // Between the row's tile and its labels: the row's own gap.
    expect(layoutElementAt(shop, { x: 95, y: 300 })).toBe(row)
  })

  test("counts a frame's edges as inside, and finds nothing off every element", () => {
    expect(layoutElementAt(shop, { x: 20, y: 248 })).toBe(card)
    expect(layoutElementAt(shop, { x: 10, y: 300 })).toBeUndefined()
  })

  test("is the button's label over the label, and the button over its padding", () => {
    expect(layoutElementAt(shop, { x: 200, y: 510 })).toBe(buttonLabel)
    expect(layoutElementAt(shop, { x: 125, y: 510 })).toBe(button)
  })
})

describe("padding", () => {
  test("is top and bottom across the frame, leading and trailing between them", () => {
    expect(paddingBands(button)).toEqual([
      { frame: { x: 119.33, y: 486.17, width: 163.33, height: 14 }, value: 14 },
      {
        frame: { x: 119.33, y: 486.17 + 47.33 - 14, width: 163.33, height: 14 },
        value: 14,
      },
      {
        frame: { x: 119.33, y: 500.17, width: 24, height: 47.33 - 28 },
        value: 24,
      },
      {
        frame: {
          x: 119.33 + 163.33 - 24,
          y: 500.17,
          width: 24,
          height: 47.33 - 28,
        },
        value: 24,
      },
    ])
  })

  test("leaves out the sides that have none, and an element without padding has no bands", () => {
    const banded = element("b", undefined, "View", [103, 201.67, 196, 30.33], {
      padding: { top: 8, leading: 0, bottom: 8, trailing: 0 },
    })
    expect(paddingBands(banded).map((band) => band.value)).toEqual([8, 8])
    expect(paddingBands(title)).toEqual([])
  })
})

describe("spacing", () => {
  test("in a vertical stack: a band between each pair of children, across the stack", () => {
    const gaps = spacingGaps(shop, screenStack)
    expect(gaps.map((gap) => formatPoints(gap.value))).toEqual([
      "16",
      "16",
      "16",
      "16",
    ])
    expect(gaps[0]!.frame).toMatchObject({ x: 20, width: 362 })
    expect(gaps[0]!.frame.y).toBeCloseTo(151.67)
    expect(gaps[0]!.frame.height).toBeCloseTo(16)
  })

  test("in a horizontal stack: the space between its tile and its labels", () => {
    expect(spacingGaps(shop, row)).toEqual([
      { frame: { x: 88, y: 260, width: 14, height: 56 }, value: 14 },
    ])
  })

  test("in a grid: its column gaps in each row and its row gaps across it", () => {
    const gaps = spacingGaps(browse, grid)
    const columns = gaps.filter((gap) => gap.frame.width === 12)
    const rows = gaps.filter((gap) => gap.frame.height === 16)
    expect(columns.map((gap) => gap.frame)).toEqual([
      { x: 195, y: 136, width: 12, height: 120 },
      { x: 195, y: 272, width: 12, height: 120 },
      { x: 195, y: 408, width: 12, height: 120 },
    ])
    expect(rows.map((gap) => gap.frame)).toEqual([
      { x: 20, y: 256, width: 362, height: 16 },
      { x: 20, y: 392, width: 362, height: 16 },
    ])
    expect(gaps).toHaveLength(5)
  })

  test("none where the element declares none", () => {
    expect(spacingGaps(shop, card)).toEqual([])
  })
})

describe("the distances from the selected element to the hovered one", () => {
  test("between two rows of the stack: the 16 points between them, through their middle", () => {
    expect(layoutDistances(card.frame, secondCard.frame)).toEqual([
      {
        axis: "vertical",
        from: { x: 201, y: 328 },
        to: { x: 201, y: 344 },
        value: 16,
      },
    ])
  })

  test("from a text to the card that holds it: to each of its four edges", () => {
    const distances = layoutDistances(name.frame, card.frame)
    expect(
      distances.map(({ axis, value }) => [axis, formatPoints(value)])
    ).toEqual([
      ["horizontal", "82"],
      ["horizontal", "169.67"],
      ["vertical", "20.67"],
      ["vertical", "39"],
    ])
    // Through the text's middle, and the other way round gives the same.
    expect(distances[0]!.from.y).toBeCloseTo(278.835)
    expect(
      layoutDistances(card.frame, name.frame).map((distance) => distance.value)
    ).toEqual(distances.map((distance) => distance.value))
  })

  test("to a tile diagonally across the grid: both gaps, each with a guide from the tile's edge", () => {
    const [running, photo] = [tiles[1]!, tiles[3]!]
    expect(layoutDistances(running.frame, photo.frame)).toEqual([
      {
        axis: "horizontal",
        from: { x: 195, y: 196 },
        to: { x: 207, y: 196 },
        value: 12,
        guide: { from: { x: 207, y: 272 }, to: { x: 207, y: 196 } },
      },
      {
        axis: "vertical",
        from: { x: 107.5, y: 256 },
        to: { x: 107.5, y: 272 },
        value: 16,
        guide: { from: { x: 207, y: 272 }, to: { x: 107.5, y: 272 } },
      },
    ])
  })

  test("none to itself, nor between edges that touch", () => {
    expect(layoutDistances(card.frame, card.frame)).toEqual([])
    const touching = { x: 20, y: 328, width: 362, height: 16 }
    expect(layoutDistances(card.frame, touching)).toEqual([])
  })
})

test("values read in points: two decimals at most, none when whole", () => {
  expect(formatPoints(16.000000001)).toBe("16")
  expect(formatPoints(35.666)).toBe("35.67")
  expect(formatPoints(0.4)).toBe("0.4")
  expect(formatPoints(-0.001)).toBe("0")
})
