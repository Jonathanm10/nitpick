// Not a port: Inspect is new to the web app (ADR-0015). The fixtures are the
// Inspect library's answers on the fictional Acme Store
// (scripts/inspect-sample/AcmeStore.swift), recorded by
// scripts/inspect-sample/fixtures.sh on an iPhone 17 Pro with iOS 26.5. Every
// value asserted here is one that app's source writes.
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import type { LayoutElement, LayoutSnapshot } from "@nitpick/core"
import { describe, expect, test } from "vitest"
import {
  layoutSnapshot,
  MalformedLayout,
} from "../src/device/layoutSnapshot.ts"

type Screen = "shop" | "scrolled" | "browse" | "sheet" | "cover"

function answer(screen: Screen): unknown {
  const fixture = new URL(`fixtures/layout/${screen}.json.gz`, import.meta.url)
  return JSON.parse(gunzipSync(readFileSync(fixture)).toString("utf8"))
}

const snapshots = new Map<Screen, LayoutSnapshot>()
function snapshot(screen: Screen): LayoutSnapshot {
  let read = snapshots.get(screen)
  if (read === undefined) {
    read = layoutSnapshot(answer(screen))
    snapshots.set(screen, read)
  }
  return read
}

function text(of: LayoutSnapshot, content: string): LayoutElement {
  const found = of.elements.find((element) => element.text?.content === content)
  if (found === undefined) throw new Error(`No text "${content}"`)
  return found
}

function parent(of: LayoutSnapshot, element: LayoutElement): LayoutElement {
  const found = of.elements.find((each) => each.id === element.parent)
  if (found === undefined) throw new Error(`${element.name} has no parent`)
  return found
}

function named(of: LayoutSnapshot, name: string): LayoutElement[] {
  return of.elements.filter((element) => element.name === name)
}

/** The rows' cards: padded boxes on a card fill. */
function cards(of: LayoutSnapshot): LayoutElement[] {
  return of.elements
    .filter((element) => element.fill === "#F4F1EA")
    .sort((a, b) => a.frame.y - b.frame.y)
}

describe("a Layout Snapshot of Acme Store's shop", () => {
  const shop = () => snapshot("shop")

  test("is in points on the iPhone 17 Pro's screen, and a hundredth of what the Build answered", () => {
    expect(shop().screen).toEqual({ width: 402, height: 874, scale: 3 })
    const answered = JSON.stringify(answer("shop")).length
    const snapshotted = JSON.stringify(shop()).length
    expect(snapshotted).toBeLessThan(answered / 50)
    expect(snapshotted).toBeLessThan(20_000)
  })

  test("reads fonts set through the app's own modifier: font, size, weight, tracking, line height and colour", () => {
    // AcmeType.title: AvenirNext-DemiBold 26, tracking 0.4, Palette.ink.
    expect(text(shop(), "New this week").text).toEqual({
      content: "New this week",
      font: "AvenirNext-DemiBold",
      family: "Avenir Next",
      size: 26,
      weight: 600,
      tracking: 0.4,
      lineHeight: 35.52,
      color: "#1F2937",
    })
    // AcmeType.caption: system 12 medium, tracking 1.2, Palette.muted.
    expect(text(shop(), "CHF 129.00").text).toMatchObject({
      font: ".SFUI-Medium",
      size: 12,
      weight: 500,
      tracking: 1.2,
      color: "#6B7280",
    })
    // AcmeType.headline: system 17 semibold, no tracking.
    const headline = text(shop(), "Trail Runner 3").text
    expect(headline).toMatchObject({ size: 17, weight: 600, color: "#1F2937" })
    expect(headline?.tracking).toBeUndefined()
  })

  test("reads a text TextKit 2 lays out, the banner's live timer, from its storage", () => {
    const timer = shop().elements.find((element) =>
      /^\d+:\d\d$/.test(element.text?.content ?? "")
    )
    expect(timer?.text).toMatchObject({
      font: ".SFUI-Medium",
      size: 12,
      weight: 500,
      tracking: 1.2,
      color: "#6B7280",
    })
  })

  test("places rows in a VStack in a ScrollView in a NavigationStack at their window points", () => {
    const screenStack = parent(shop(), text(shop(), "New this week"))
    expect(screenStack).toMatchObject({
      name: "VStack",
      spacing: { axis: "vertical", value: 16 },
    })
    // .padding(.horizontal, 20) around the VStack, below the 116 pt bar.
    expect(parent(shop(), screenStack).padding).toEqual({
      top: 0,
      leading: 20,
      bottom: 0,
      trailing: 20,
    })
    expect(screenStack.frame).toMatchObject({ x: 20, y: 116, width: 362 })
    // Rows on screen sit the VStack's 16 points apart.
    const rows = cards(shop())
    expect(rows.length).toBeGreaterThanOrEqual(6)
    for (const [above, below] of rows
      .slice(0, -1)
      .map((row, index) => [row, rows[index + 1]])) {
      expect(below.frame.y - (above.frame.y + above.frame.height)).toBeCloseTo(
        16,
        2
      )
    }
  })

  test("reads a row's padding, corner radius, fill, stack spacing and image tile", () => {
    const row = cards(shop())[0]
    expect(row).toMatchObject({
      padding: { top: 12, leading: 12, bottom: 12, trailing: 12 },
      cornerRadius: 18,
      frame: { x: 20, width: 362, height: 80 },
    })
    const stack = shop().elements.find((element) => element.parent === row.id)
    expect(stack).toMatchObject({
      name: "HStack",
      spacing: { axis: "horizontal", value: 14 },
    })
    const tile = shop().elements.find(
      (element) => element.parent === stack?.id && element.fill === "#FF6B35"
    )
    expect(tile).toMatchObject({
      name: "Frame",
      cornerRadius: 12,
      frame: { width: 56, height: 56 },
    })
    const symbol = shop().elements.find(
      (element) => element.parent === tile?.id
    )
    expect(symbol).toMatchObject({ name: "Image", image: "figure.run" })
    expect(parent(shop(), text(shop(), "Trail Runner 3")).spacing).toEqual({
      axis: "vertical",
      value: 4,
    })
  })

  test("reads a colour background and the padding inside it", () => {
    const banner = shop().elements.find((element) => element.fill === "#EDEBFF")
    expect(banner).toMatchObject({
      name: "Frame",
      frame: { x: 20, width: 362 },
    })
    const padded = shop().elements.find(
      (element) => element.parent === banner?.id
    )
    expect(padded?.padding).toEqual({
      top: 8,
      leading: 0,
      bottom: 8,
      trailing: 0,
    })
    expect(
      parent(shop(), text(shop(), "Free shipping ends in")).spacing
    ).toEqual({
      axis: "horizontal",
      value: 6,
    })
  })

  test("places the toolbar's cart, its own hosting view, in the navigation bar", () => {
    const cart = shop().elements.find((element) => element.image === "cart")
    expect(cart?.name).toBe("Image")
    expect(cart?.parent).toBeUndefined()
    expect(cart!.frame.x + cart!.frame.width).toBeLessThanOrEqual(402)
    expect(cart!.frame.y).toBeGreaterThan(62)
    expect(cart!.frame.y + cart!.frame.height).toBeLessThan(116)
  })

  test("lists elements as they are drawn: each after the one it sits in, siblings in source order", () => {
    const elements = shop().elements
    const index = new Map(elements.map((element, at) => [element.id, at]))
    expect(index.size).toBe(elements.length)
    for (const element of elements) {
      if (element.parent !== undefined) {
        expect(index.get(element.parent)).toBeLessThan(index.get(element.id)!)
      }
    }
    const order = [
      "New this week",
      "Seven things we like, picked by the Acme team.",
      "Trail Runner 3",
    ]
    const positions = order.map((content) =>
      elements.indexOf(text(shop(), content))
    )
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })
})

describe("a Layout Snapshot of the shop scrolled by 100 points", () => {
  test("moves every row up by the scroll", () => {
    const shop = snapshot("shop")
    const scrolled = snapshot("scrolled")
    for (const content of ["New this week", "Trail Runner 3", "CHF 89.00"]) {
      expect(text(scrolled, content).frame.y).toBeCloseTo(
        text(shop, content).frame.y - 100,
        2
      )
    }
  })

  test("names the app's button by its enums and reads their values", () => {
    const button = named(snapshot("scrolled"), "AcmeButton")
    expect(button).toHaveLength(1)
    // AcmeButton(title: "Check out", style: .primary, size: .regular).
    expect(button[0]).toMatchObject({
      properties: { style: "primary", size: "regular" },
      padding: { top: 14, leading: 24, bottom: 14, trailing: 24 },
      cornerRadius: 14,
      fill: "#5B4CF0",
    })
    expect(text(snapshot("scrolled"), "Check out")).toMatchObject({
      parent: button[0].id,
      text: { font: ".SFUI-Bold", size: 16, weight: 700, color: "#FFFFFF" },
    })
  })
})

describe("a Layout Snapshot of the browse grid", () => {
  const browse = () => snapshot("browse")

  test("reads a LazyVGrid's column and row spacing, and measures as declared", () => {
    const [grid] = named(browse(), "LazyVGrid")
    expect(grid.gridSpacing).toEqual({ horizontal: 12, vertical: 16 })
    expect(parent(browse(), grid).padding).toEqual({
      top: 20,
      leading: 20,
      bottom: 20,
      trailing: 20,
    })
    const tiles = cards(browse()).sort(
      (a, b) => a.frame.y - b.frame.y || a.frame.x - b.frame.x
    )
    expect(tiles).toHaveLength(6)
    for (const tile of tiles) {
      expect(tile).toMatchObject({ parent: grid.id, cornerRadius: 20 })
      expect(tile.frame.height).toBe(120)
    }
    const [first, second, third] = tiles
    expect(second.frame.x - (first.frame.x + first.frame.width)).toBeCloseTo(
      12,
      2
    )
    expect(third.frame.y - (first.frame.y + first.frame.height)).toBeCloseTo(
      16,
      2
    )
  })
})

describe("a Layout Snapshot under a sheet and a full-screen cover", () => {
  test("a medium sheet over the tab bar draws over the shop, which still shows above it", () => {
    const sheet = snapshot("sheet")
    const behind = sheet.elements.indexOf(text(sheet, "New this week"))
    const onTop = sheet.elements.indexOf(text(sheet, "Your cart"))
    expect(behind).toBeGreaterThanOrEqual(0)
    expect(onTop).toBeGreaterThan(behind)
    // iOS 26 sets the sheet back 8 points and scales it by 386/402: the
    // sheet's frames are where it is drawn.
    const [cart] = named(sheet, "CartSheet")
    expect(cart.frame).toMatchObject({ x: 8, width: 386 })
    expect(text(sheet, "Your cart").frame.y).toBeGreaterThan(415)
    // Its own values are the source's, unscaled.
    expect(named(sheet, "AcmeButton")[0]).toMatchObject({
      properties: { style: "primary", size: "compact" },
      padding: { top: 8, leading: 16, bottom: 8, trailing: 16 },
      cornerRadius: 10,
    })
    expect(parent(sheet, text(sheet, "Your cart")).spacing).toEqual({
      axis: "vertical",
      value: 12,
    })
  })

  test("a full-screen cover hides the screen it covers", () => {
    const cover = snapshot("cover")
    expect(
      cover.elements.some(
        (element) => element.text?.content === "New this week"
      )
    ).toBe(false)
    expect(named(cover, "WelcomeCover")[0].padding).toEqual({
      top: 32,
      leading: 32,
      bottom: 32,
      trailing: 32,
    })
    // .lineSpacing(6) on AcmeType.body's 15 pt system font.
    const body = text(
      cover,
      "Sign in to keep your cart, your wish list and your orders on every device you use."
    )
    expect(body.text).toMatchObject({ size: 15, weight: 400, lineHeight: 23.9 })
    expect(parent(cover, body).spacing).toEqual({ axis: "vertical", value: 20 })
    expect(named(cover, "AcmeButton")[0]).toMatchObject({
      properties: { style: "secondary", size: "regular" },
      fill: "#EDEBFF",
    })
    expect(text(cover, "Start shopping").text?.color).toBe("#5B4CF0")
  })
})

describe("reading the tree", () => {
  const node = (
    type: string,
    geometry: { position?: number[]; size?: number[]; transform?: unknown },
    children: unknown[] = []
  ) => ({
    properties: [
      { id: 0, attribute: { type: `SwiftUI.${type}`, readableType: type } },
      ...(geometry.transform === undefined
        ? []
        : [{ id: 2, attribute: { value: geometry.transform } }]),
      ...(geometry.position === undefined
        ? []
        : [{ id: 3, attribute: { value: geometry.position } }]),
      ...(geometry.size === undefined
        ? []
        : [{ id: 4, attribute: { value: geometry.size } }]),
    ],
    children,
  })
  const screen = { width: 402, height: 874, scale: 3 }

  test("a position is in the nearest transform's space: its translations added, its position adjustment taken off", () => {
    const tree = node("Image", {
      position: [10, 20],
      size: [30, 40],
      transform: {
        items: [{}, { translation: [0, -100] }, { translation: [0, 116] }],
        positionAdjustment: [4, 6],
      },
    })

    const { elements } = layoutSnapshot({
      screen,
      hostingViews: [{ frame: {}, texts: {}, fonts: {}, tree: [tree] }],
    })

    expect(elements[0].frame).toEqual({ x: 6, y: 30, width: 30, height: 40 })
  })

  test("an affine transform scales and moves the frame", () => {
    const tree = node("Image", {
      position: [100, 50],
      size: [200, 20],
      transform: {
        items: [
          { translation: [0, 10] },
          {
            affineTransform: [
              0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1, 0, 8, 400, 0, 1,
            ],
          },
        ],
        positionAdjustment: [0, 0],
      },
    })

    const { elements } = layoutSnapshot({
      screen,
      hostingViews: [{ frame: {}, texts: {}, fonts: {}, tree: [tree] }],
    })

    expect(elements[0].frame).toEqual({ x: 58, y: 430, width: 100, height: 10 })
  })

  test("an answer that isn't a layout is refused, and odd parts of one read as absent", () => {
    expect(() => layoutSnapshot({ hostingViews: [] })).toThrow(MalformedLayout)
    expect(() => layoutSnapshot("<html>")).toThrow(MalformedLayout)
    expect(
      layoutSnapshot({
        screen,
        hostingViews: [
          null,
          { tree: "not a tree" },
          { tree: [{ properties: 7 }] },
        ],
      }).elements
    ).toEqual([])
  })
})
