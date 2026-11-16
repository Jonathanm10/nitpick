// Turns what the Inspect library answers (server/inspector/Inspector.m) into
// the Layout Snapshot the page hovers over (ADR-0015). The reading of
// SwiftUI's debug tree is ported from the spike's devmode.py: the coordinate
// rule, padding, stack and grid spacing, and text attributes. Then the nodes
// that share one frame become one element, as a designer sees one box.
//
// The tree comes from the Build's process, so nothing in it is trusted: a
// part that isn't shaped as expected reads as absent.
import type {
  LayoutElement,
  LayoutFrame,
  LayoutInsets,
  LayoutSnapshot,
  LayoutText,
} from "@nitpick/core"

/** The library's answer isn't a layout at all. */
export class MalformedLayout extends Error {
  constructor() {
    super("The Build answered Inspect with something that isn't a layout.")
    this.name = "MalformedLayout"
  }
}

/** One of SwiftUI's `_ViewDebug` attributes: a value, or a tree of them. */
interface Attribute {
  /** Fully qualified: "SwiftUI.Text", "AcmeStore.AcmeButton.Style". */
  readonly type?: unknown
  /** As the source spells it: "Text", "AcmeButton.Style". */
  readonly readableType?: unknown
  readonly name?: unknown
  readonly value?: unknown
  readonly subattributes?: unknown
}

/** An attribute's value with the dotted path of names that leads to it. */
interface Leaf {
  readonly path: string
  readonly name: string
  readonly type: string
  readonly readableType: string
  readonly value: unknown
}

/** `_ViewDebug.Property` raw values: what the library asks SwiftUI for. */
const property = { type: 0, value: 1, transform: 2, position: 3, size: 4 }

/** A run of text with the attributes iOS resolved for it. */
interface TextRun {
  readonly text: string
  readonly font?: ResolvedFont
  readonly color?: ReadonlyArray<number>
  readonly tracking?: number
  readonly lineSpacing?: number
  readonly minimumLineHeight?: number
  readonly maximumLineHeight?: number
}

interface ResolvedFont {
  readonly name: string
  readonly family: string
  readonly size: number
  /** UIFont's weight trait, -1 to 1; 0 is regular. */
  readonly weight?: number
  readonly lineHeight?: number
}

/** What one hosting view's text storages and fonts resolve to, by address. */
interface Resolved {
  readonly texts: Readonly<Record<string, unknown>>
  readonly fonts: Readonly<Record<string, unknown>>
}

type Point = readonly [number, number]

/** An element while the tree is read; merged nodes add to it. */
interface Draft {
  readonly id: string
  readonly parent: Draft | undefined
  readonly frame: LayoutFrame
  kind?: string
  appView?: string
  component?: string
  hasFrameLayout?: boolean
  shape?: string
  padding?: LayoutInsets
  spacing?: LayoutElement["spacing"]
  gridSpacing?: LayoutElement["gridSpacing"]
  text?: LayoutText
  image?: string
  cornerRadius?: number
  fill?: string
  properties?: Map<string, string>
  hasChildren: boolean
  /** It lies under an `allowsHitTesting(false)`, so it takes no touches. */
  passive: boolean
}

interface Context {
  readonly transform: (point: Point) => Point
  readonly element: Draft | undefined
  /**
   * The element a padding just merged into, while no node with a frame of
   * its own came since: a padding nested right in it adds to its padding.
   */
  readonly paddedElement: Draft | undefined
  readonly path: string
  readonly resolved: Resolved
  /** Under an `allowsHitTesting(false)`. */
  readonly passive: boolean
  /**
   * The element the parent node made, if it made one: a ModifiedContent
   * node holds the frame, and its modifier comes as its child.
   */
  readonly madeByParent: Draft | undefined
}

/**
 * The snapshot of one answer from the library: its hosting views back to
 * front, each read as a tree of elements, keeping those on screen.
 */
export function layoutSnapshot(layout: unknown): LayoutSnapshot {
  if (!isRecord(layout) || !isRecord(layout.screen)) throw new MalformedLayout()
  const { width, height, scale } = layout.screen
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    typeof scale !== "number" ||
    !Array.isArray(layout.hostingViews)
  ) {
    throw new MalformedLayout()
  }
  const drafts: Draft[] = []
  layout.hostingViews.forEach((host: unknown, index) => {
    if (!isRecord(host) || !Array.isArray(host.tree)) return
    const resolved = {
      texts: isRecord(host.texts) ? host.texts : {},
      fonts: isRecord(host.fonts) ? host.fonts : {},
    }
    host.tree.forEach((node: unknown, position) =>
      read(node, drafts, {
        transform: (point) => point,
        element: undefined,
        paddedElement: undefined,
        path: `${index}/${position}`,
        resolved,
        passive: false,
        madeByParent: undefined,
      })
    )
  })
  return {
    screen: { width, height, scale },
    elements: elementsOf(drafts, { x: 0, y: 0, width, height }),
  }
}

function read(node: unknown, drafts: Draft[], context: Context): void {
  if (!isRecord(node)) return
  const attributes = new Map<number, Attribute>()
  for (const entry of Array.isArray(node.properties) ? node.properties : []) {
    if (
      isRecord(entry) &&
      typeof entry.id === "number" &&
      isRecord(entry.attribute)
    ) {
      attributes.set(entry.id, entry.attribute)
    }
  }
  const type = attributes.get(property.type)
  const readableType = text(type?.readableType)
  const values = leaves(attributes.get(property.value))
  if (isHidden(readableType, values)) return

  const transform =
    transformOf(attributes.get(property.transform)?.value) ?? context.transform
  const position = pair(attributes.get(property.position)?.value)
  const size = pair(attributes.get(property.size)?.value)
  const ownFrame =
    position && size ? frameThrough(transform, position, size) : undefined
  const isPadding = readableType === "_PaddingLayout"
  const passive =
    context.passive ||
    (readableType === "_AllowsHitTestingModifier" &&
      values.some(
        (leaf) => leaf.name === "allowsHitTesting" && leaf.value === false
      ))
  // The modifier applies to the element its ModifiedContent made, not to
  // one further up whose frame it shares.
  if (passive && context.madeByParent !== undefined) {
    context.madeByParent.passive = true
  }

  let element = context.element
  const nestedPadding =
    isPadding && element !== undefined && context.paddedElement === element
  if (
    ownFrame !== undefined &&
    !nestedPadding &&
    (element === undefined || !sameFrame(ownFrame, element.frame))
  ) {
    if (element !== undefined) element.hasChildren = true
    element = {
      id: elementID(context.path),
      parent: element,
      frame: ownFrame,
      hasChildren: false,
      passive,
    }
    drafts.push(element)
  }
  if (element === undefined) return
  const made = element !== context.element ? element : undefined

  merge(element, node, {
    readableType,
    qualifiedType: text(type?.type),
    values,
    frame: ownFrame ?? element.frame,
    transform,
    resolved: context.resolved,
  })

  const children = Array.isArray(node.children) ? node.children : []
  // A stack's tree lists its children last first; read them as the source
  // has them, the order a ZStack draws in. Their paths keep the tree's order.
  const inOrder = children.map((child: unknown, index) => ({ child, index }))
  if (readableType.startsWith("_VariadicView.Tree<")) inOrder.reverse()
  inOrder.forEach(({ child, index }) =>
    read(child, drafts, {
      transform,
      element,
      paddedElement: isPadding
        ? element
        : ownFrame === undefined
          ? context.paddedElement
          : undefined,
      path: `${context.path}.${index}`,
      resolved: context.resolved,
      passive,
      madeByParent: made,
    })
  )
}

/** A cell kept for reuse, or a view made fully transparent, isn't seen. */
function isHidden(readableType: string, values: ReadonlyArray<Leaf>): boolean {
  if (readableType === "HiddenForReuseEffect") {
    return values.some(
      (leaf) => leaf.name === "isHiddenForReuse" && leaf.value === true
    )
  }
  if (
    readableType === "OpacityRendererEffect" ||
    readableType === "_OpacityEffect"
  ) {
    return values.some((leaf) => leaf.name === "opacity" && leaf.value === 0)
  }
  return false
}

const stackAxes: Readonly<Record<string, "horizontal" | "vertical">> = {
  VStack: "vertical",
  LazyVStack: "vertical",
  HStack: "horizontal",
  LazyHStack: "horizontal",
}

const containerKinds = new Set([
  ...Object.keys(stackAxes),
  "ZStack",
  "LazyVGrid",
  "LazyHGrid",
  "Grid",
  "ScrollView",
  "Button",
])

/** Adds what one node says to the element it belongs to. */
function merge(
  element: Draft,
  node: Record<string, unknown>,
  {
    readableType,
    qualifiedType,
    values,
    frame,
    transform,
    resolved,
  }: {
    readonly readableType: string
    readonly qualifiedType: string
    readonly values: ReadonlyArray<Leaf>
    /** The node's frame: its own, or its element's. */
    readonly frame: LayoutFrame
    readonly transform: (point: Point) => Point
    readonly resolved: Resolved
  }
): void {
  const base = readableType.replace(/<.*$/s, "")
  // What it shows names it before a stack SwiftUI wraps it in, which then
  // has nothing to space.
  const shows = (kind: string | undefined) =>
    kind === "Text" || kind === "Image"
  if (shows(readableType)) {
    element.kind = readableType
    element.spacing = undefined
  } else if (containerKinds.has(base)) element.kind ??= base
  if (base === "_FrameLayout" || base === "_FlexFrameLayout")
    element.hasFrameLayout = true
  if (isAppType(qualifiedType) && !readableType.includes("<"))
    element.appView ??= readableType

  // A path through a tuple's element (`value..1`) is a child's value.
  const number = (suffix: string) =>
    values.find(
      (leaf) =>
        leaf.path.endsWith(suffix) &&
        !leaf.path.includes("..") &&
        typeof leaf.value === "number"
    )?.value as number | undefined

  if (base === "_PaddingLayout") {
    addPadding(element, padding(values, node, frame, transform))
  }
  const axis = stackAxes[base]
  const stackSpacing = number("root.spacing")
  if (
    axis !== undefined &&
    stackSpacing !== undefined &&
    !shows(element.kind)
  ) {
    element.spacing ??= { axis, value: stackSpacing }
  }
  if (base === "LazyVGrid" || base === "LazyHGrid") {
    const across = number(
      base === "LazyVGrid" ? "columns.spacing" : "rows.spacing"
    )
    if (across !== undefined && stackSpacing !== undefined) {
      element.gridSpacing ??=
        base === "LazyVGrid"
          ? { horizontal: across, vertical: stackSpacing }
          : { horizontal: stackSpacing, vertical: across }
    }
  }
  if (base === "Grid") {
    const horizontal = number("horizontalSpacing")
    const vertical = number("verticalSpacing")
    if (horizontal !== undefined && vertical !== undefined) {
      element.gridSpacing ??= { horizontal, vertical }
    }
  }

  const shape = /^_ShapeView<(\w+)/.exec(readableType)?.[1]
  // A clip shape, as `.clipShape(RoundedRectangle(…))`, rounds its element
  // as a shape it is filled with does.
  const clipShape = /^_ClipEffect<(\w+)/.exec(readableType)?.[1]
  if (shape !== undefined || base === "_BackgroundStyleModifier") {
    element.fill ??= fillColor(values)
  }
  if (shape !== undefined) element.shape ??= shape
  const outline = shape ?? clipShape
  if (outline !== undefined) {
    const corner = pair(
      values.find((leaf) => leaf.path === "shape.cornerSize")?.value
    )
    if (corner !== undefined) element.cornerRadius ??= corner[0]
    else if (outline === "Capsule" || outline === "Circle") {
      element.cornerRadius ??=
        Math.min(element.frame.width, element.frame.height) / 2
    }
  }

  if (readableType === "Image") {
    const name = values.find(
      (leaf) => leaf.path === "provider.base.name"
    )?.value
    if (typeof name === "string") element.image ??= name
  }
  if (readableType === "StyledTextContentView") {
    element.text ??= layoutText(textRuns(values, resolved))
  }
  addAppProperties(element, values)
}

/**
 * The app's own enum values a node holds: values of the app's types that
 * are strings, as SwiftUI writes an enum case. A path through a tuple's
 * element (`value..2`) belongs to a child, so it is left to that child; a
 * name with two values, as a ForEach's data has, says nothing.
 */
function addAppProperties(element: Draft, values: ReadonlyArray<Leaf>): void {
  const found = new Map<string, string>()
  const owners = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (const leaf of values) {
    if (typeof leaf.value !== "string" || !isAppType(leaf.type)) continue
    if (leaf.path.includes("..") || leaf.name === "") continue
    const known = found.get(leaf.name)
    if (known !== undefined && known !== leaf.value) ambiguous.add(leaf.name)
    found.set(leaf.name, leaf.value)
    // AcmeButton.Style: the type it is declared in names the component.
    const owner = /^(\w+)\.\w+$/.exec(leaf.readableType)?.[1]
    if (owner !== undefined && !owners.has(leaf.name)) {
      owners.set(leaf.name, owner)
    }
  }
  for (const name of ambiguous) found.delete(name)
  if (found.size === 0) return
  // Only a value of its own names it: a ForEach's items, each with its
  // own, name nothing.
  const owner = [...found.keys()].find((name) => owners.has(name))
  if (owner !== undefined) element.component ??= owners.get(owner)
  element.properties ??= new Map()
  for (const [name, value] of found) element.properties.set(name, value)
}

/**
 * Modules whose types are the platform's, not the app's. A type of any other
 * module, the app's own or a library it bundles, counts as the app's.
 */
const platformModules = new Set([
  "Swift",
  "SwiftUI",
  "SwiftUICore",
  "UIKit",
  "UIKitCore",
  "Foundation",
  "FoundationEssentials",
  "FoundationInternationalization",
  "CoreGraphics",
  "CoreFoundation",
  "CoreText",
  "QuartzCore",
  "AttributeGraph",
  "Combine",
  "Observation",
  "Dispatch",
  "ObjectiveC",
  "Darwin",
  "os",
  "MapKit",
  "Charts",
  "AVKit",
  "PhotosUI",
  "StoreKit",
  "WebKit",
])

function isAppType(qualifiedType: string): boolean {
  const module = /^(\w+)\./.exec(qualifiedType)?.[1]
  return (
    module !== undefined &&
    !module.startsWith("_") &&
    !platformModules.has(module)
  )
}

/**
 * A padding's insets on the edges it applies to: as declared, or, for a
 * `.padding()` that leaves them to the system, as measured from its
 * content's frame inside the padded one.
 */
function padding(
  values: ReadonlyArray<Leaf>,
  node: Record<string, unknown>,
  padded: LayoutFrame,
  transform: (point: Point) => Point
): LayoutInsets {
  const edgesValue = values.find((leaf) => leaf.path === "edges")?.value
  const edges =
    typeof edgesValue === "string" ? edgesValue : "top leading bottom trailing"
  const declared = (edge: keyof LayoutInsets) =>
    values.find(
      (leaf) => leaf.path === `insets.${edge}` && typeof leaf.value === "number"
    )?.value as number | undefined
  const content = firstOwnFrame(node, transform)
  const measured: LayoutInsets = content
    ? {
        top: content.y - padded.y,
        leading: content.x - padded.x,
        bottom: padded.y + padded.height - (content.y + content.height),
        trailing: padded.x + padded.width - (content.x + content.width),
      }
    : { top: 0, leading: 0, bottom: 0, trailing: 0 }
  const inset = (edge: keyof LayoutInsets) =>
    edges.includes(edge) ? (declared(edge) ?? measured[edge]) : 0
  return {
    top: inset("top"),
    leading: inset("leading"),
    bottom: inset("bottom"),
    trailing: inset("trailing"),
  }
}

function addPadding(element: Draft, insets: LayoutInsets): void {
  const current = element.padding ?? {
    top: 0,
    leading: 0,
    bottom: 0,
    trailing: 0,
  }
  element.padding = {
    top: current.top + insets.top,
    leading: current.leading + insets.leading,
    bottom: current.bottom + insets.bottom,
    trailing: current.trailing + insets.trailing,
  }
}

/** The frame of the first node down a padding's content that has its own. */
function firstOwnFrame(
  node: Record<string, unknown>,
  transform: (point: Point) => Point
): LayoutFrame | undefined {
  const children = Array.isArray(node.children) ? node.children : []
  const child: unknown = children[0]
  if (!isRecord(child)) return undefined
  const attributes = new Map<number, unknown>()
  for (const entry of Array.isArray(child.properties) ? child.properties : []) {
    if (
      isRecord(entry) &&
      typeof entry.id === "number" &&
      isRecord(entry.attribute)
    ) {
      attributes.set(entry.id, entry.attribute.value)
    }
  }
  const own = transformOf(attributes.get(property.transform)) ?? transform
  const position = pair(attributes.get(property.position))
  const size = pair(attributes.get(property.size))
  if (position && size) return frameThrough(own, position, size)
  return firstOwnFrame(child, own)
}

/**
 * SwiftUI's coordinate rule, from the spike: a node's position is in the
 * space of the nearest transform at or above it. That transform's items run
 * from the innermost, a scroll offset, out to the window, a sheet's scale
 * included; its positionAdjustment is already in the position.
 */
function transformOf(value: unknown): ((point: Point) => Point) | undefined {
  if (!isRecord(value)) return undefined
  const items = Array.isArray(value.items) ? value.items : []
  const [adjustX, adjustY] = pair(value.positionAdjustment) ?? [0, 0]
  return ([x, y]) => {
    let px = x - adjustX
    let py = y - adjustY
    for (const item of items) {
      if (!isRecord(item)) continue
      const translation = pair(item.translation)
      const matrix = numbers(item.affineTransform)
      if (translation !== undefined) {
        px += translation[0]
        py += translation[1]
      } else if (matrix?.length === 16) {
        // CATransform3D, row by row: m11 m12 … m41 m42 m43 m44.
        ;[px, py] = [
          matrix[0] * px + matrix[4] * py + matrix[12],
          matrix[1] * px + matrix[5] * py + matrix[13],
        ]
      } else if (matrix?.length === 6) {
        // CGAffineTransform: a b c d tx ty.
        ;[px, py] = [
          matrix[0] * px + matrix[2] * py + matrix[4],
          matrix[1] * px + matrix[3] * py + matrix[5],
        ]
      }
    }
    return [px, py]
  }
}

function frameThrough(
  transform: (point: Point) => Point,
  [x, y]: Point,
  [width, height]: Point
): LayoutFrame {
  const corners = [
    transform([x, y]),
    transform([x + width, y]),
    transform([x, y + height]),
    transform([x + width, y + height]),
  ]
  const xs = corners.map(([cornerX]) => cornerX)
  const ys = corners.map(([, cornerY]) => cornerY)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  return {
    x: minX,
    y: minY,
    width: Math.max(...xs) - minX,
    height: Math.max(...ys) - minY,
  }
}

/** Within a third of a point, a pixel at 3x. */
function sameFrame(a: LayoutFrame, b: LayoutFrame): boolean {
  const close = (lhs: number, rhs: number) => Math.abs(lhs - rhs) < 0.34
  return (
    close(a.x, b.x) &&
    close(a.y, b.y) &&
    close(a.width, b.width) &&
    close(a.height, b.height)
  )
}

/**
 * A text's runs. SwiftUI keeps most texts as an attributed string, which the
 * tree prints with its attributes and the address of each font; a text
 * TextKit 2 lays out, such as a live timer, is named by its storage, which
 * the library read instead.
 */
function textRuns(values: ReadonlyArray<Leaf>, resolved: Resolved): TextRun[] {
  const storage = values.find(
    (leaf) => leaf.path === "text.layoutManager.textStorage"
  )
  const address = /0x[0-9a-f]+/i.exec(text(storage?.value))?.[0]
  const runs = address === undefined ? undefined : resolved.texts[address]
  if (Array.isArray(runs)) return runs.flatMap(storageRun)
  const described = values.find((leaf) => leaf.path === "text.cache.string")
  return typeof described?.value === "string"
    ? describedRuns(described.value, resolved)
    : []
}

function storageRun(run: unknown): TextRun[] {
  if (!isRecord(run) || typeof run.text !== "string") return []
  const paragraph = isRecord(run.paragraph) ? run.paragraph : {}
  return [
    {
      text: run.text,
      font: resolvedFont(run.font),
      color: numbers(run.color),
      tracking: finite(run.tracking) ?? finite(run.kern),
      lineSpacing: finite(paragraph.lineSpacing),
      minimumLineHeight: finite(paragraph.minimumLineHeight),
      maximumLineHeight: finite(paragraph.maximumLineHeight),
    },
  ]
}

/**
 * NSAttributedString's description: each run's text, then its attributes
 * between braces, one per line, as `Name = value;`.
 */
function describedRuns(description: string, resolved: Resolved): TextRun[] {
  return [...description.matchAll(/([\s\S]*?)\{\n([\s\S]*?)\n\}/g)].map(
    ([, runText, attributes]) => {
      const value = (pattern: RegExp) => pattern.exec(attributes)?.[1]
      const fontAddress = value(/NSFont = "<\w+: (0x[0-9a-f]+)>/i)
      const fontName = value(/font-family: \\"(.*?)\\"/)
      const fontSize = Number(value(/font-size: ([\d.]+)pt/))
      const rgb =
        /NSColor = "UIExtendedSRGBColorSpace ([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.e]+)"/.exec(
          attributes
        )
      const gray =
        /NSColor = "UIExtendedGrayColorSpace ([-\d.e]+) ([-\d.e]+)"/.exec(
          attributes
        )
      const lineHeights = /LineHeight ([\d.]+)\/([\d.]+)/.exec(attributes)
      return {
        text: runText,
        font:
          resolvedFont(fontAddress && resolved.fonts[fontAddress]) ??
          (fontName !== undefined && fontSize > 0
            ? { name: fontName, family: fontName, size: fontSize }
            : undefined),
        color: rgb
          ? rgb.slice(1).map(Number)
          : gray
            ? [gray[1], gray[1], gray[1], gray[2]].map(Number)
            : undefined,
        tracking:
          finite(Number(value(/CTTracking = "?(-?[\d.]+)"?;/))) ??
          finite(Number(value(/NSKern = "?(-?[\d.]+)"?;/))),
        lineSpacing: finite(Number(value(/LineSpacing (-?[\d.]+)/))),
        minimumLineHeight: lineHeights ? Number(lineHeights[1]) : undefined,
        maximumLineHeight: lineHeights ? Number(lineHeights[2]) : undefined,
      }
    }
  )
}

function resolvedFont(font: unknown): ResolvedFont | undefined {
  if (!isRecord(font)) return undefined
  const { name, family, size } = font
  if (
    typeof name !== "string" ||
    typeof family !== "string" ||
    typeof size !== "number"
  ) {
    return undefined
  }
  return {
    name,
    family,
    size,
    weight: finite(font.weight),
    lineHeight: finite(font.lineHeight),
  }
}

/** The text as the page shows it: all of it, styled as its first run is. */
function layoutText(runs: ReadonlyArray<TextRun>): LayoutText | undefined {
  const first = runs[0]
  const font = first?.font
  if (font === undefined) return undefined
  const lineHeight = first.maximumLineHeight
    ? first.maximumLineHeight
    : font.lineHeight === undefined
      ? undefined
      : Math.max(font.lineHeight, first.minimumLineHeight ?? 0)
  const color = hexColor(first.color)
  return {
    content: runs.map((run) => run.text).join(""),
    font: font.name,
    family: font.family,
    size: font.size,
    ...(font.weight !== undefined && { weight: cssWeight(font.weight) }),
    ...(first.tracking !== undefined &&
      first.tracking !== 0 && { tracking: first.tracking }),
    ...(lineHeight !== undefined && {
      lineHeight: lineHeight + (first.lineSpacing ?? 0),
    }),
    ...(color !== undefined && { color }),
  }
}

/** UIFont's weight traits, lightest first, and their CSS weights. */
const weights: ReadonlyArray<readonly [number, number]> = [
  [-0.8, 100],
  [-0.6, 200],
  [-0.4, 300],
  [0, 400],
  [0.23, 500],
  [0.3, 600],
  [0.4, 700],
  [0.56, 800],
  [0.62, 900],
]

function cssWeight(trait: number): number {
  return weights.reduce((nearest, candidate) =>
    Math.abs(candidate[0] - trait) < Math.abs(nearest[0] - trait)
      ? candidate
      : nearest
  )[1]
}

/**
 * A fill as SwiftUI resolved it, `{"color": [r, g, b, a]}` in sRGB, or a
 * system colour it keeps by name, `{"red": {}}`, whose value follows the
 * appearance.
 */
function fillColor(values: ReadonlyArray<Leaf>): string | undefined {
  const resolved = values.find(
    (leaf) => leaf.path === "style.provider.base.color"
  )
  if (isRecord(resolved?.value)) return hexColor(numbers(resolved.value.color))
  const system = values.find(
    (leaf) =>
      leaf.path === "style.provider.base" &&
      leaf.readableType === "SystemColorType"
  )
  const names = isRecord(system?.value) ? Object.keys(system.value) : []
  return names.length === 1 ? names[0] : undefined
}

function hexColor(
  components: ReadonlyArray<number> | undefined
): string | undefined {
  if (components === undefined || components.length < 3) return undefined
  const byte = (component: number) =>
    Math.round(Math.min(Math.max(component, 0), 1) * 255)
      .toString(16)
      .toUpperCase()
      .padStart(2, "0")
  const [red, green, blue, alpha = 1] = components
  const opaque = Math.round(Math.min(Math.max(alpha, 0), 1) * 255) === 255
  return `#${byte(red)}${byte(green)}${byte(blue)}${opaque ? "" : byte(alpha)}`
}

/**
 * The drafts as the page gets them: an element that says nothing a designer
 * reads, a wrapper SwiftUI adds, gives way to its children; one off screen
 * or without area goes, and so does decoration that spills; values are
 * rounded to a hundredth of a point.
 */
function elementsOf(
  drafts: ReadonlyArray<Draft>,
  screen: LayoutFrame
): LayoutElement[] {
  dropRepeatedProperties(drafts)
  const kept = new Set(
    drafts.filter(
      (draft) =>
        draft.frame.width > 0 &&
        draft.frame.height > 0 &&
        intersects(draft.frame, screen) &&
        !spills(draft) &&
        (nameOf(draft) !== "View" ||
          draft.padding !== undefined ||
          draft.fill !== undefined ||
          draft.cornerRadius !== undefined ||
          draft.properties !== undefined)
    )
  )
  const keptParent = (draft: Draft): Draft | undefined => {
    let parent = draft.parent
    while (parent !== undefined && !kept.has(parent)) parent = parent.parent
    return parent
  }
  return drafts
    .filter((draft) => kept.has(draft))
    .map((draft) => {
      const parent = keptParent(draft)
      const padding = draft.padding
      return {
        id: draft.id,
        ...(parent !== undefined && { parent: parent.id }),
        name: nameOf(draft),
        frame: {
          x: rounded(draft.frame.x),
          y: rounded(draft.frame.y),
          width: rounded(draft.frame.width),
          height: rounded(draft.frame.height),
        },
        ...(padding !== undefined && {
          padding: {
            top: rounded(padding.top),
            leading: rounded(padding.leading),
            bottom: rounded(padding.bottom),
            trailing: rounded(padding.trailing),
          },
        }),
        ...(draft.spacing !== undefined && { spacing: draft.spacing }),
        ...(draft.gridSpacing !== undefined && {
          gridSpacing: draft.gridSpacing,
        }),
        ...(draft.text !== undefined && {
          text: {
            ...draft.text,
            size: rounded(draft.text.size),
            ...(draft.text.tracking !== undefined && {
              tracking: rounded(draft.text.tracking),
            }),
            ...(draft.text.lineHeight !== undefined && {
              lineHeight: rounded(draft.text.lineHeight),
            }),
          },
        }),
        ...(draft.image !== undefined && { image: draft.image }),
        ...(draft.cornerRadius !== undefined && {
          cornerRadius: rounded(draft.cornerRadius),
        }),
        ...(draft.fill !== undefined && { fill: draft.fill }),
        ...(draft.properties !== undefined && {
          properties: Object.fromEntries(draft.properties),
        }),
      }
    })
}

/**
 * A component's values show on SwiftUI's wrappers around it too; they
 * belong to the innermost element that holds them all.
 */
function dropRepeatedProperties(drafts: ReadonlyArray<Draft>): void {
  const signature = (draft: Draft) =>
    draft.properties && JSON.stringify([...draft.properties].sort())
  for (const draft of drafts) {
    const own = signature(draft)
    if (own === undefined) continue
    const repeated = drafts.some((other) => {
      if (other === draft || signature(other) !== own) return false
      for (
        let parent = other.parent;
        parent !== undefined;
        parent = parent.parent
      ) {
        if (parent === draft) return true
      }
      return false
    })
    if (repeated) {
      draft.properties = undefined
      draft.component = undefined
    }
  }
}

function nameOf(draft: Draft): string {
  return (
    draft.component ??
    draft.appView ??
    draft.kind ??
    (draft.shape !== undefined && !draft.hasChildren
      ? draft.shape
      : undefined) ??
    (draft.hasFrameLayout ? "Frame" : "View")
  )
}

/**
 * Decoration the app keeps from touches and lets reach past the element it
 * decorates, as a glass surface's backdrop or a glow that a card's clip
 * trims: what shows of it lies inside that element, so its frame isn't a box
 * a designer sees, and it would take the pointer from everything it covers.
 */
function spills(draft: Draft): boolean {
  if (!draft.passive) return false
  let host = draft.parent
  while (host?.passive) host = host.parent
  return host !== undefined && !within(draft.frame, host.frame)
}

/** `inner` lies in `outer`, give or take a third of a point. */
function within(inner: LayoutFrame, outer: LayoutFrame): boolean {
  const slack = 0.34
  return (
    inner.x >= outer.x - slack &&
    inner.y >= outer.y - slack &&
    inner.x + inner.width <= outer.x + outer.width + slack &&
    inner.y + inner.height <= outer.y + outer.height + slack
  )
}

function intersects(a: LayoutFrame, b: LayoutFrame): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  )
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100 || 0
}

/**
 * An id from the element's place in the tree, its hosting view and the path
 * of child indexes down to it: FNV-1a, in base 36.
 */
function elementID(path: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < path.length; index++) {
    hash ^= path.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

/** An attribute's values, depth first, each with its path of names. */
function leaves(
  attribute: Attribute | undefined,
  prefix = "",
  into: Leaf[] = []
): Leaf[] {
  if (!isRecord(attribute)) return into
  const name = text(attribute.name)
  const path =
    name !== "" && prefix !== "" ? `${prefix}.${name}` : name || prefix
  if ("value" in attribute) {
    into.push({
      path,
      name,
      type: text(attribute.type),
      readableType: text(attribute.readableType),
      value: attribute.value,
    })
  }
  if (Array.isArray(attribute.subattributes)) {
    for (const sub of attribute.subattributes)
      leaves(sub as Attribute, path, into)
  }
  return into
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function pair(value: unknown): Point | undefined {
  const values = numbers(value)
  return values?.length === 2 ? [values[0], values[1]] : undefined
}

function numbers(value: unknown): number[] | undefined {
  return Array.isArray(value) && value.every((each) => typeof each === "number")
    ? value
    : undefined
}
