import AppKit
import Foundation
import NitpickCore
import Observation

/// Thin shell state over the app core: every mutation is a core call plus an
/// assignment — no logic worth seaming (PRD testing decisions).
@MainActor
@Observable
final class AppModel {
    private let core: AppCore

    private(set) var build: Build?
    private(set) var devices: [SimulatorDevice] = []
    var selectedDeviceID: SimulatorDevice.ID?
    /// True once the Build has been launched on the selected device.
    private(set) var isReviewing = false
    /// The core-rendered annotated capture — what the designer sees while
    /// editing, and exactly what filing flattens.
    private(set) var capturedImage: NSImage?
    /// The capture's native pixel size, for view↔pixel coordinate mapping.
    private(set) var capturePixelSize: CGSize?
    /// The Finding in progress: created at capture (stamping the Device
    /// Context of that moment), annotated while reviewing, filed at the end.
    /// Summary and description ride the text fields until filing.
    private(set) var finding: Finding?
    /// Changes with every capture — the annotation surface keys its
    /// in-flight draft reset off this, since two captures on the same
    /// device share a pixel size.
    private(set) var captureID = UUID()
    var annotationTool: AnnotationTool = .pen
    var annotationColor: AnnotationColor = .default
    /// True while a placed text label awaits its text — set by the
    /// annotation surface; filing is gated on it so a visible draft can
    /// never be silently dropped from the filed image.
    var hasPendingLabelDraft = false
    private(set) var isBusy = false
    var errorMessage: String?

    /// The verified YouTrack connection; nil shows the first-run settings.
    private(set) var youTrack: YouTrackConnection?
    var youTrackInstanceURLField = ""
    var youTrackTokenField = ""
    var selectedProjectID: YouTrackProject.ID?
    var youTrackErrorMessage: String?

    /// The active Review Session: Build + project, pinned at Start review.
    private(set) var session: ReviewSession?
    var summaryField = ""
    var descriptionField = ""
    /// The last filed issue — ID + link, shown until the next capture.
    private(set) var filedIssue: FiledIssue?

    init(core: AppCore = AppCore(environment: .live(), workspaceDirectory: AppModel.defaultWorkspaceDirectory())) {
        self.core = core
    }

    /// `~/Library/Application Support/Nitpick` — extracted Builds and captures.
    private static func defaultWorkspaceDirectory() -> URL {
        URL.applicationSupportDirectory.appendingPathComponent("Nitpick", isDirectory: true)
    }

    var selectedDevice: SimulatorDevice? {
        devices.first { $0.id == selectedDeviceID }
    }

    var selectedProject: YouTrackProject? {
        youTrack?.projects.first { $0.id == selectedProjectID }
    }

    /// The relaunch path: resume a saved connection, prefilling the
    /// instance URL either way.
    func loadYouTrack() async {
        await perform(reportingTo: \.youTrackErrorMessage) {
            if let url = try core.youTrackInstanceURL() {
                youTrackInstanceURLField = url.absoluteString
            }
            guard let connection = try await core.reconnectYouTrack() else { return }
            connected(connection)
        }
    }

    func connectYouTrack() async {
        await perform(reportingTo: \.youTrackErrorMessage) {
            let connection = try await core.connectYouTrack(
                instanceURL: youTrackInstanceURLField,
                token: youTrackTokenField
            )
            youTrackTokenField = ""
            connected(connection)
        }
    }

    /// Back to the settings form, e.g. to point at another instance or paste
    /// a fresh token. The saved connection stays until the next connect.
    func editYouTrackConnection() {
        youTrack = nil
        youTrackErrorMessage = nil
    }

    private func connected(_ connection: YouTrackConnection) {
        // A new connection ends the active Review Session: its pinned
        // project belongs to the connection it was chosen from, and filing
        // must never pair an old project with new credentials.
        session = nil
        isReviewing = false
        // Keep the picker's choice only when the identical project (id,
        // key, and name) exists on this connection — an entity-id collision
        // across instances must not silently select a different project.
        let previous = selectedProject
        youTrack = connection
        if previous == nil || !connection.projects.contains(where: { $0 == previous }) {
            selectedProjectID = connection.projects.first?.id
        }
    }

    func ingest(_ url: URL) async {
        await perform {
            build = try await core.ingestBuild(at: url)
            isReviewing = false
            session = nil
            filedIssue = nil
            clearCapture()
            devices = try await core.simulatorDevices()
            if selectedDevice == nil {
                selectedDeviceID = devices.first?.id
            }
        }
    }

    /// Starts the Review Session: launches the Build and pins the chosen
    /// project exactly once — filing never re-asks (PRD session boundary:
    /// a Review Session always pairs Build + project).
    func startReview() async {
        guard let build, let device = selectedDevice, let project = selectedProject else { return }
        await perform {
            try await core.launch(build, on: device)
            isReviewing = true
            session = ReviewSession(build: build, project: project)
            filedIssue = nil
        }
    }

    func captureScreen() async {
        guard let device = selectedDevice else { return }
        await perform {
            let png = try await core.captureScreen(of: device)
            finding = Finding(
                summary: "",
                description: "",
                screenshotPNG: png,
                deviceContext: DeviceContext(device: device)
            )
            filedIssue = nil
            captureID = UUID()
            // The surface resets its live draft off captureID, but if it
            // was unmounted first its onChange never fires — the model
            // owns the gate, so the model resets it.
            hasPendingLabelDraft = false
            refreshAnnotatedImage()
        }
    }

    // MARK: - Annotation editing (all state lives in the core's Finding)

    var canUndoAnnotation: Bool { finding?.canUndo ?? false }
    var canRedoAnnotation: Bool { finding?.canRedo ?? false }

    var annotationMetrics: AnnotationMetrics? {
        capturePixelSize.map(AnnotationMetrics.init(imageSize:))
    }

    /// Editing freezes while filing is in flight: the request carries a
    /// copy of the Finding, so a late edit would show in the preview yet
    /// be missing from the filed issue.
    func addAnnotation(_ shape: Annotation.Shape) {
        guard !isBusy else { return }
        finding?.add(Annotation(shape, color: annotationColor))
        refreshAnnotatedImage()
    }

    func undoAnnotation() {
        guard !isBusy else { return }
        finding?.undo()
        refreshAnnotatedImage()
    }

    func redoAnnotation() {
        guard !isBusy else { return }
        finding?.redo()
        refreshAnnotatedImage()
    }

    private func refreshAnnotatedImage() {
        guard let finding else {
            capturedImage = nil
            capturePixelSize = nil
            return
        }
        if let image = try? finding.annotatedScreenshotImage() {
            capturedImage = NSImage(cgImage: image, size: NSSize(width: image.width, height: image.height))
            capturePixelSize = CGSize(width: image.width, height: image.height)
        } else {
            // An undecodable capture: show nothing rather than lie; filing
            // will surface the real error.
            capturedImage = NSImage(data: finding.screenshotPNG)
            capturePixelSize = capturedImage.map { CGSize(width: $0.size.width, height: $0.size.height) }
        }
    }

    /// Files the composed Finding into the session's project and surfaces
    /// the resulting issue ID + link; the session tray arrives with issue 05.
    /// This is the moment Annotations stop being editable.
    func fileFinding() async {
        guard let session, var finding, !hasPendingLabelDraft else { return }
        await perform {
            finding.summary = summaryField
            finding.description = descriptionField
            filedIssue = try await core.file(finding, in: session)
            summaryField = ""
            descriptionField = ""
            clearCapture()
        }
    }

    private func clearCapture() {
        capturedImage = nil
        capturePixelSize = nil
        finding = nil
        hasPendingLabelDraft = false
    }

    private func perform(
        reportingTo errorKeyPath: ReferenceWritableKeyPath<AppModel, String?> = \.errorMessage,
        _ action: () async throws -> Void
    ) async {
        isBusy = true
        self[keyPath: errorKeyPath] = nil
        defer { isBusy = false }
        do {
            try await action()
        } catch {
            self[keyPath: errorKeyPath] = error.localizedDescription
        }
    }
}
