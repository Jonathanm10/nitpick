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
    private(set) var capturedImage: NSImage?
    private(set) var capturedPNG: Data?
    /// The Device Context stamped at capture time — filing must describe
    /// the capture, not whatever the device picker shows at filing time.
    private(set) var captureContext: DeviceContext?
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
            capturedImage = NSImage(data: png)
            capturedPNG = png
            captureContext = DeviceContext(device: device)
            filedIssue = nil
        }
    }

    /// Files the composed Finding into the session's project and surfaces
    /// the resulting issue ID + link; the session tray arrives with issue 05.
    func fileFinding() async {
        guard let session, let png = capturedPNG, let context = captureContext else { return }
        await perform {
            let finding = Finding(
                summary: summaryField,
                description: descriptionField,
                screenshotPNG: png,
                deviceContext: context
            )
            filedIssue = try await core.file(finding, in: session)
            summaryField = ""
            descriptionField = ""
            clearCapture()
        }
    }

    private func clearCapture() {
        capturedImage = nil
        capturedPNG = nil
        captureContext = nil
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
