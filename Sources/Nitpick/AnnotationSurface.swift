import AppKit
import NitpickCore
import SwiftUI

/// Which Annotation tool the next gesture uses — a UI concept; the shapes
/// themselves are core vocabulary. Select picks up a committed Annotation;
/// the rest draw.
enum AnnotationTool: String, CaseIterable, Identifiable {
    case select, pen, arrow, rectangle, label

    var id: String { rawValue }

    var symbolName: String {
        switch self {
        case .select: "cursorarrow"
        case .pen: "scribble"
        case .arrow: "arrow.up.right"
        case .rectangle: "rectangle"
        case .label: "textformat"
        }
    }

    /// Tool shortcuts live only when the surface has keyboard focus and no
    /// text field is active. They are mnemonic and keep tool switching
    /// instant: no animation, just a state change.
    var shortcutKey: KeyEquivalent {
        switch self {
        case .select: "v"
        case .pen: "p"
        case .arrow: "a"
        case .rectangle: "r"
        case .label: "t"
        }
    }

    var help: String {
        switch self {
        case .select: "Select — click a mark to select it"
        case .pen: "Pen — draw freehand"
        case .arrow: "Arrow — point at an element"
        case .rectangle: "Rectangle — mark a region"
        case .label: "Text label — click to place a note"
        }
    }
}

extension AnnotationColor {
    /// The palette color for SwiftUI, from the same sRGB components the
    /// core's renderer flattens with.
    var swatch: Color {
        Color(.sRGB, red: components.red, green: components.green, blue: components.blue)
    }
}

/// The Annotation surface on a captured Finding: draw with the selected
/// tool over the core-rendered annotated image. The view holds only the
/// in-flight gesture; every committed edit is a core call.
struct AnnotationSurface: View {
    @Bindable var model: AppModel

    /// The shape being drawn right now, in image pixel coordinates.
    @State private var draft: Annotation.Shape?
    /// A text label being typed, before it becomes an Annotation.
    @State private var labelPosition: CGPoint?
    @State private var labelText = ""
    @FocusState private var labelFocused: Bool
    /// Key focus for the surface itself: granted by a Select-tool click,
    /// so Delete/Backspace and Esc act on the selection only while no
    /// text field (Summary, Description, label editor) is being edited.
    @FocusState private var surfaceFocused: Bool
    /// The Select tool's gesture phase, decided at the first cursor
    /// movement: a move when the press landed on the selected shape,
    /// otherwise nothing until release selects. View-local like the
    /// draft — the model owns the move itself.
    private enum SelectGesture { case undecided, moving, rejected }
    @State private var selectGesture = SelectGesture.undecided

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            AnnotationToolbar(model: model)
            if let image = model.capturedImage, let pixelSize = model.capturePixelSize {
                surface(image: image, pixelSize: pixelSize)
            }
        }
        // Keyed off capture identity, not pixel size: two captures on the
        // same device share dimensions but must never share a draft.
        .onChange(of: model.captureID) {
            draft = nil
            selectGesture = .undecided
            labelPosition = nil
            labelText = ""
            surfaceFocused = true
        }
        // The model gates filing on this: a placed-but-unsubmitted label
        // is visible in the preview and must never be silently dropped.
        .onChange(of: labelPosition) {
            model.hasPendingLabelDraft = labelPosition != nil
        }
        // Losing focus commits rather than discards — the designer saw
        // the typed text on the capture.
        .onChange(of: labelFocused) {
            if !labelFocused {
                commitLabel()
            }
        }
        // Freeze edits while filing is in flight: the request carries a
        // copy of the Finding — a late mark would preview but not file.
        .disabled(model.isBusy)
    }

    private func surface(image: NSImage, pixelSize: CGSize) -> some View {
        GeometryReader { proxy in
            let scale = min(proxy.size.width / pixelSize.width, proxy.size.height / pixelSize.height)
            ZStack(alignment: .topLeading) {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                rightClickDelete(scale: scale, pixelSize: pixelSize)
                moveOverlay(scale: scale)
                draftOverlay(scale: scale)
                selectionIndicator(scale: scale)
                labelEditor(scale: scale)
            }
            .frame(width: pixelSize.width * scale, height: pixelSize.height * scale)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .gesture(drawGesture(scale: scale, pixelSize: pixelSize))
            .focusable()
            .focusEffectDisabled()
            .focused($surfaceFocused)
            .defaultFocus($surfaceFocused, true)
            .onDeleteCommand { model.deleteSelectedAnnotation() }
            // The surface holds focus right after a capture, so it must
            // run the same escape rule as the editor scope — installed
            // only when the rule would act, or the mis-capture discard
            // (PRD story 10) would die here as a consumed no-op.
            .onExitCommand(perform: model.editorEscapeWouldAct ? { model.handleEditorEscape() } : nil)
            .onKeyPress(keys: [.upArrow, .downArrow, .leftArrow, .rightArrow]) { press in
                // Nudge rides the surface's own key focus: a focused text
                // field (Summary, Description, label editor) keeps its
                // arrows. With focus, the press is consumed even with
                // nothing selected — an idle arrow must not scroll or
                // move focus.
                guard surfaceFocused else { return .ignored }
                model.nudgeSelectedAnnotation(
                    Self.nudgeDirection(for: press.key),
                    multiplier: press.modifiers.contains(.shift) ? 5 : 1
                )
                return .handled
            }
            .onKeyPress(keys: Set(AnnotationTool.allCases.map(\.shortcutKey))) { press in
                guard !labelFocused else { return .ignored }
                switch press.key {
                case AnnotationTool.select.shortcutKey:
                    model.annotationTool = .select
                case AnnotationTool.pen.shortcutKey:
                    model.annotationTool = .pen
                case AnnotationTool.arrow.shortcutKey:
                    model.annotationTool = .arrow
                case AnnotationTool.rectangle.shortcutKey:
                    model.annotationTool = .rectangle
                case AnnotationTool.label.shortcutKey:
                    model.annotationTool = .label
                default:
                    return .ignored
                }
                return .handled
            }
        }
        .aspectRatio(pixelSize, contentMode: .fit)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func drawGesture(scale: CGFloat, pixelSize: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                let point = pixelPoint(value.location, scale: scale, in: pixelSize)
                let start = pixelPoint(value.startLocation, scale: scale, in: pixelSize)
                switch model.annotationTool {
                case .pen:
                    if case .pen(var points) = draft {
                        points.append(point)
                        draft = .pen(points: points)
                    } else {
                        draft = .pen(points: [start, point])
                    }
                case .arrow:
                    draft = .arrow(from: start, to: point)
                case .rectangle:
                    draft = .rectangle(rect(from: start, to: point))
                case .label:
                    break
                case .select:
                    selectToolChanged(
                        from: start, to: point,
                        travel: hypot(value.translation.width, value.translation.height)
                    )
                }
            }
            .onEnded { value in
                defer { draft = nil }
                switch model.annotationTool {
                case .select:
                    selectToolEnded(pressedAt: pixelPoint(value.startLocation, scale: scale, in: pixelSize))
                case .label:
                    // A still-open draft commits before the next one opens
                    // — typed text is never silently discarded.
                    commitLabel()
                    labelPosition = pixelPoint(value.location, scale: scale, in: pixelSize)
                    labelText = ""
                    labelFocused = true
                default:
                    if let draft {
                        model.addAnnotation(draft)
                    }
                }
            }
    }

    /// The Select tool's press-and-move, in image pixels: a hair of
    /// cursor `travel` (view points) tells a drag from a click — a click
    /// without movement stays pure selection. Translation begins only
    /// from a hit on the selected shape; empty-surface drags do nothing.
    private func selectToolChanged(from start: CGPoint, to point: CGPoint, travel: CGFloat) {
        switch selectGesture {
        case .rejected:
            break
        case .undecided:
            guard travel >= 2 else { break }
            if model.beginAnnotationDrag(at: start) {
                selectGesture = .moving
                model.updateAnnotationDrag(offset: CGVector(dx: point.x - start.x, dy: point.y - start.y))
            } else {
                selectGesture = .rejected
            }
        case .moving:
            model.updateAnnotationDrag(offset: CGVector(dx: point.x - start.x, dy: point.y - start.y))
        }
    }

    /// The Select tool's release: a move commits whole — one undo step.
    /// Anything else acts as the click at the press point: hit → select,
    /// empty surface → deselect — a drag from empty surface never picks
    /// up whatever it happens to end over. Either way the surface takes
    /// key focus, so Delete reaches the selection instead of a lingering
    /// text field.
    private func selectToolEnded(pressedAt start: CGPoint) {
        if selectGesture == .moving {
            model.endAnnotationDrag()
        } else {
            model.selectAnnotation(at: start)
        }
        selectGesture = .undecided
        surfaceFocused = true
    }

    /// An arrow key as a unit vector in image pixels — origin top-left,
    /// so Up is -y.
    private static func nudgeDirection(for key: KeyEquivalent) -> CGVector {
        switch key {
        case .upArrow: CGVector(dx: 0, dy: -1)
        case .downArrow: CGVector(dx: 0, dy: 1)
        case .leftArrow: CGVector(dx: -1, dy: 0)
        default: CGVector(dx: 1, dy: 0)  // .rightArrow — the keys set admits no other
        }
    }

    /// The in-flight shape, previewed with the same metrics the core
    /// flattens with — what the designer sees is what files.
    @ViewBuilder
    private func draftOverlay(scale: CGFloat) -> some View {
        if let draft, let metrics = model.annotationMetrics {
            Canvas { context, _ in
                let style = StrokeStyle(
                    lineWidth: metrics.strokeWidth * scale, lineCap: .round, lineJoin: .round
                )
                let color = GraphicsContext.Shading.color(model.annotationColor.swatch)
                switch draft {
                case .pen(let points):
                    var path = Path()
                    path.addLines(points.map { CGPoint(x: $0.x * scale, y: $0.y * scale) })
                    context.stroke(path, with: color, style: style)
                case .arrow(let from, let to):
                    let shaft = arrowShaft(
                        from: CGPoint(x: from.x * scale, y: from.y * scale),
                        to: CGPoint(x: to.x * scale, y: to.y * scale),
                        metrics: metrics, scale: scale
                    )
                    context.stroke(shaft.line, with: color, style: style)
                    context.fill(shaft.head, with: color)
                case .rectangle(let rect):
                    let scaled = CGRect(
                        x: rect.minX * scale, y: rect.minY * scale,
                        width: rect.width * scale, height: rect.height * scale
                    )
                    context.stroke(Path(scaled), with: color, style: style)
                case .label:
                    break
                }
            }
            .allowsHitTesting(false)
        }
    }

    /// The dragged Annotation riding the cursor: the shape alone on
    /// transparency, rendered by the core at its pre-drag position and
    /// shifted by the drag's whole-pixel offset — renderer truth, so the
    /// mark tracking the cursor is exactly what release flattens.
    @ViewBuilder
    private func moveOverlay(scale: CGFloat) -> some View {
        if let drag = model.annotationDrag {
            Image(nsImage: drag.overlayImage)
                .resizable()
                .interpolation(.high)
                .offset(x: drag.offset.dx * scale, y: drag.offset.dy * scale)
                .allowsHitTesting(false)
        }
    }

    /// The right-click layer: Delete on any committed Annotation, with
    /// any tool active — right-click never draws, so the gesture is
    /// unclaimed. It sits directly above the image and below the label
    /// editor, whose text field keeps its own context menu.
    private func rightClickDelete(scale: CGFloat, pixelSize: CGSize) -> some View {
        RightClickDeleteSurface(
            annotationIndex: { model.annotationIndex(at: pixelPoint($0, scale: scale, in: pixelSize)) },
            deleteAnnotation: { model.deleteAnnotation(at: $0) }
        )
    }

    /// The selected Annotation as the designer currently sees it: mid-
    /// drag, the pre-drag shape translated by the live offset, so the
    /// selection indicator rides along with the mark.
    private var displayedSelection: Annotation? {
        if let drag = model.annotationDrag {
            return drag.annotation.translated(by: drag.offset)
        }
        return model.selectedAnnotation
    }

    /// The selection indicator: a dashed outline around the selected
    /// Annotation's rendered bounds. Pure workspace chrome at view scale —
    /// it never passes through the flattening renderer, so it can never
    /// appear in flattened or filed output.
    @ViewBuilder
    private func selectionIndicator(scale: CGFloat) -> some View {
        if let annotation = displayedSelection, let metrics = model.annotationMetrics,
           let bounds = annotation.boundingRect(metrics: metrics) {
            let padded = bounds.insetBy(dx: -metrics.strokeWidth, dy: -metrics.strokeWidth)
            RoundedRectangle(cornerRadius: 4)
                .stroke(Color.accentColor, style: StrokeStyle(lineWidth: 1.5, dash: [5, 3]))
                .frame(width: padded.width * scale, height: padded.height * scale)
                .offset(x: padded.minX * scale, y: padded.minY * scale)
                .allowsHitTesting(false)
        }
    }

    @ViewBuilder
    private func labelEditor(scale: CGFloat) -> some View {
        if let position = labelPosition, let metrics = model.annotationMetrics {
            TextField("Note", text: $labelText)
                .textFieldStyle(.plain)
                .font(.system(size: metrics.fontSize * scale, weight: .bold))
                .foregroundStyle(model.annotationColor.swatch)
                .focused($labelFocused)
                .onSubmit(commitLabel)
                .onExitCommand {
                    labelPosition = nil
                    labelText = ""
                }
                .frame(width: 220, alignment: .leading)
                .offset(x: position.x * scale, y: position.y * scale)
        }
    }

    private func commitLabel() {
        if let position = labelPosition {
            let text = labelText.trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty {
                model.addAnnotation(.label(text, at: position))
            }
        }
        labelPosition = nil
        labelText = ""
    }

    // MARK: - Geometry

    private func pixelPoint(_ location: CGPoint, scale: CGFloat, in pixelSize: CGSize) -> CGPoint {
        CGPoint(
            x: (location.x / scale).clamped(to: 0...pixelSize.width),
            y: (location.y / scale).clamped(to: 0...pixelSize.height)
        )
    }

    private func rect(from start: CGPoint, to end: CGPoint) -> CGRect {
        CGRect(
            x: min(start.x, end.x), y: min(start.y, end.y),
            width: abs(end.x - start.x), height: abs(end.y - start.y)
        )
    }

    /// Mirrors the core renderer's arrow geometry: shaft stops where the
    /// filled head begins.
    private func arrowShaft(
        from: CGPoint, to: CGPoint, metrics: AnnotationMetrics, scale: CGFloat
    ) -> (line: Path, head: Path) {
        var line = Path()
        var head = Path()
        let length = hypot(to.x - from.x, to.y - from.y)
        guard length > 0 else { return (line, head) }
        let direction = CGPoint(x: (to.x - from.x) / length, y: (to.y - from.y) / length)
        let headLength = metrics.arrowHeadLength * scale
        let headWidth = metrics.arrowHeadWidth * scale
        let base = CGPoint(x: to.x - direction.x * headLength, y: to.y - direction.y * headLength)
        let normal = CGPoint(x: -direction.y, y: direction.x)
        line.move(to: from)
        line.addLine(to: base)
        head.move(to: to)
        head.addLine(to: CGPoint(x: base.x + normal.x * headWidth / 2, y: base.y + normal.y * headWidth / 2))
        head.addLine(to: CGPoint(x: base.x - normal.x * headWidth / 2, y: base.y - normal.y * headWidth / 2))
        head.closeSubpath()
        return (line, head)
    }
}

/// The AppKit layer for the one gesture SwiftUI cannot express: a
/// location-aware context menu. Hit-testing rides `NSApp.currentEvent`,
/// so the view exists only for right mouse events — every other event
/// falls through to the surface beneath, leaving each tool's left-click
/// and drag untouched.
private struct RightClickDeleteSurface: NSViewRepresentable {
    /// `.disabled` reaches AppKit only through the environment: while
    /// filing is in flight the menu freezes with the rest of the surface.
    @Environment(\.isEnabled) private var isEnabled
    /// View-space point → index of the committed Annotation it hits.
    let annotationIndex: (CGPoint) -> Int?
    let deleteAnnotation: (Int) -> Void

    func makeNSView(context: Context) -> RightClickMenuView { RightClickMenuView() }

    /// Closures re-capture the view's current scale on every layout, so
    /// the point→pixel mapping never goes stale across a window resize.
    func updateNSView(_ view: RightClickMenuView, context: Context) {
        view.isEnabled = isEnabled
        view.annotationIndex = annotationIndex
        view.deleteAnnotation = deleteAnnotation
    }
}

/// Offers Delete when a right-click lands on an Annotation; shows
/// nothing on empty surface.
private final class RightClickMenuView: NSView {
    var isEnabled = true
    var annotationIndex: ((CGPoint) -> Int?)?
    var deleteAnnotation: ((Int) -> Void)?

    /// Top-left origin — the same space as the view points the surface's
    /// pixel mapping expects.
    override var isFlipped: Bool { true }

    /// Transparent to every event but a right-click: returning nil sends
    /// hit-testing past this view.
    override func hitTest(_ point: NSPoint) -> NSView? {
        switch NSApp.currentEvent?.type {
        case .rightMouseDown, .rightMouseUp, .rightMouseDragged:
            super.hitTest(point)
        default:
            nil
        }
    }

    /// The menu, or — on empty surface — nothing. The hit index rides
    /// the item's tag to the action; the model re-checks it against the
    /// current Annotations, since a menu can stay open indefinitely.
    override func menu(for event: NSEvent) -> NSMenu? {
        guard isEnabled,
              let index = annotationIndex?(convert(event.locationInWindow, from: nil))
        else { return nil }
        let menu = NSMenu()
        let delete = NSMenuItem(title: "Delete", action: #selector(deleteItem(_:)), keyEquivalent: "")
        delete.target = self
        delete.tag = index
        menu.addItem(delete)
        return menu
    }

    @objc private func deleteItem(_ sender: NSMenuItem) {
        deleteAnnotation?(sender.tag)
    }
}

extension CGFloat {
    fileprivate func clamped(to range: ClosedRange<CGFloat>) -> CGFloat {
        Swift.min(Swift.max(self, range.lowerBound), range.upperBound)
    }
}
