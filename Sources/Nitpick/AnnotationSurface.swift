import NitpickCore
import SwiftUI

/// Which Annotation tool the next gesture draws — a UI concept; the shapes
/// themselves are core vocabulary.
enum AnnotationTool: String, CaseIterable, Identifiable {
    case pen, arrow, rectangle, label

    var id: String { rawValue }

    var symbolName: String {
        switch self {
        case .pen: "scribble"
        case .arrow: "arrow.up.right"
        case .rectangle: "rectangle"
        case .label: "textformat"
        }
    }

    var help: String {
        switch self {
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
            labelPosition = nil
            labelText = ""
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
                draftOverlay(scale: scale)
                labelEditor(scale: scale)
            }
            .frame(width: pixelSize.width * scale, height: pixelSize.height * scale)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .gesture(drawGesture(scale: scale, pixelSize: pixelSize))
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
                }
            }
            .onEnded { value in
                defer { draft = nil }
                switch model.annotationTool {
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

/// The annotation toolbar: tool picker, colors, undo/redo. A standalone
/// view so the frozen pane can reserve its exact slot (hidden, disabled)
/// and render a filed capture at the same size the editable surface
/// gives it (issue 01: "same pane, same size").
struct AnnotationToolbar: View {
    @Bindable var model: AppModel

    var body: some View {
        HStack(spacing: 16) {
            Picker("Tool", selection: $model.annotationTool) {
                ForEach(AnnotationTool.allCases) { tool in
                    Image(systemName: tool.symbolName)
                        .help(tool.help)
                        .tag(tool)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
            HStack(spacing: 6) {
                ForEach(AnnotationColor.allCases, id: \.self) { color in
                    Button {
                        model.annotationColor = color
                    } label: {
                        Circle()
                            .fill(color.swatch)
                            .strokeBorder(
                                .primary.opacity(model.annotationColor == color ? 0.9 : 0.2),
                                lineWidth: model.annotationColor == color ? 2 : 1
                            )
                            .frame(width: 18, height: 18)
                    }
                    .buttonStyle(.plain)
                    .help(color.rawValue.capitalized)
                }
            }
            Spacer()

            Button {
                model.undoAnnotation()
            } label: {
                Image(systemName: "arrow.uturn.backward")
            }
            .keyboardShortcut("z", modifiers: .command)
            .disabled(!model.canUndoAnnotation)
            .help("Undo")
            Button {
                model.redoAnnotation()
            } label: {
                Image(systemName: "arrow.uturn.forward")
            }
            .keyboardShortcut("z", modifiers: [.command, .shift])
            .disabled(!model.canRedoAnnotation)
            .help("Redo")
        }
    }
}

extension CGFloat {
    fileprivate func clamped(to range: ClosedRange<CGFloat>) -> CGFloat {
        Swift.min(Swift.max(self, range.lowerBound), range.upperBound)
    }
}
