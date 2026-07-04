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
    /// The device the Build is actually running on — the stamp source for
    /// every capture. Set only after a successful launch, so a failed or
    /// in-flight switch can never stamp a Finding with a device the Build
    /// isn't running on.
    private(set) var reviewDevice: SimulatorDevice?
    /// The Device Settings currently applied to the review device — the
    /// settings half of the stamp. Advances only after the core confirms
    /// the simulator accepted the change.
    private(set) var deviceSettings = DeviceSettings()
    /// The core-rendered annotated capture — what the designer sees while
    /// editing, and exactly what filing flattens.
    private(set) var capturedImage: NSImage?
    /// The capture's native pixel size, for view↔pixel coordinate mapping.
    private(set) var capturePixelSize: CGSize?
    /// The tray item under edit: the capture that just landed, or whatever
    /// tray row the designer selected. Nil hides the editor.
    private(set) var selectedItemID: TrayItem.ID?
    /// Changes whenever the editor's target changes — a new capture or a
    /// different tray selection — so the annotation surface resets its
    /// in-flight draft even when two targets share a pixel size.
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

    /// The active Review Session: Build + project pinned at Start review,
    /// and the session tray its captures accumulate in.
    private(set) var session: ReviewSession?

    var selectedItem: TrayItem? {
        guard let selectedItemID else { return nil }
        return session?.tray.first { $0.id == selectedItemID }
    }

    /// The selected Finding's summary and description, bound to the editor
    /// fields — every edit writes straight into the tray item.
    var summaryField: String {
        get { selectedItem?.finding.summary ?? "" }
        set { editSelectedFinding { $0.summary = newValue } }
    }

    var descriptionField: String {
        get { selectedItem?.finding.description ?? "" }
        set { editSelectedFinding { $0.description = newValue } }
    }

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
        reviewDevice = nil
        clearSelection()
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
            reviewDevice = nil
            session = nil
            clearSelection()
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
            // Every session starts from default Device Settings; launch
            // applies them, so the stamp matches the simulator from the
            // first capture on.
            let settings = DeviceSettings()
            try await core.launch(build, on: device, settings: settings)
            deviceSettings = settings
            reviewDevice = device
            isReviewing = true
            session = ReviewSession(build: build, project: project)
            clearSelection()
        }
    }

    /// Mid-session device switch (PRD story 7): relaunches the session's
    /// Build on the new device under the session's current Device Settings.
    /// The session — Build, project, tray — is untouched. On failure the
    /// picker reverts to the device still running the Build.
    func switchDevice(to id: SimulatorDevice.ID?) async {
        guard isReviewing, !isBusy, let build,
              let id, id != reviewDevice?.id,
              let device = devices.first(where: { $0.id == id })
        else { return }
        selectedDeviceID = id
        await perform {
            do {
                try await core.launch(build, on: device, settings: deviceSettings)
                reviewDevice = device
            } catch {
                selectedDeviceID = reviewDevice?.id
                throw error
            }
        }
    }

    func setDynamicTypeSize(_ size: DeviceSettings.DynamicTypeSize) async {
        guard !isBusy, let device = reviewDevice, size != deviceSettings.dynamicTypeSize else { return }
        await perform {
            try await core.setDynamicTypeSize(size, on: device)
            deviceSettings.dynamicTypeSize = size
        }
    }

    func setAppearance(_ appearance: DeviceSettings.Appearance) async {
        guard !isBusy, let device = reviewDevice, appearance != deviceSettings.appearance else { return }
        await perform {
            try await core.setAppearance(appearance, on: device)
            deviceSettings.appearance = appearance
        }
    }

    func captureScreen() async {
        // A pending label draft pins the editor: retargeting before the
        // surface resolves it would drop the visible note or commit it to
        // the wrong Finding — same invariant as the filing gate. Busy means
        // a switch or settings change may be in flight — capturing then
        // could stamp a Device Context the screenshot wasn't taken under.
        guard !isBusy, let device = reviewDevice, session != nil, !hasPendingLabelDraft else { return }
        await perform {
            let png = try await core.captureScreen(of: device)
            // The capture drops straight into the tray as a Finding — no
            // filing dialog (PRD story 22) — and opens in the editor,
            // stamped with the Device Context in effect right now.
            selectedItemID = session?.addFinding(Finding(
                summary: "",
                description: "",
                screenshotPNG: png,
                deviceContext: DeviceContext(device: device, settings: deviceSettings)
            ))
            captureID = UUID()
            // The surface resets its live draft off captureID, but if it
            // was unmounted first its onChange never fires — the model
            // owns the gate, so the model resets it.
            hasPendingLabelDraft = false
            refreshAnnotatedImage()
        }
    }

    // MARK: - Tray selection and Annotation editing (state lives in the core's session)

    var canUndoAnnotation: Bool { selectedItem?.finding.canUndo ?? false }
    var canRedoAnnotation: Bool { selectedItem?.finding.canRedo ?? false }

    var annotationMetrics: AnnotationMetrics? {
        capturePixelSize.map(AnnotationMetrics.init(imageSize:))
    }

    /// Opens a tray item in the editor. Refused while a label draft is
    /// pending: the surface still owns the typed text, and retargeting
    /// first would land its commit on the wrong Finding.
    func selectItem(_ id: TrayItem.ID) {
        guard selectedItemID != id, !hasPendingLabelDraft else { return }
        selectedItemID = id
        captureID = UUID()
        hasPendingLabelDraft = false
        refreshAnnotatedImage()
    }

    /// Removes a Finding from the tray; the core refuses to discard
    /// anything filing has already touched. Refused while a label draft
    /// is pending, like every other editor-retargeting mutation.
    func discardFinding(id: TrayItem.ID) {
        guard !isBusy, !hasPendingLabelDraft else { return }
        session?.discardFinding(id: id)
        if selectedItemID == id, selectedItem == nil {
            clearSelection()
        }
    }

    func addAnnotation(_ shape: Annotation.Shape) {
        editSelectedFinding { $0.add(Annotation(shape, color: annotationColor)) }
        refreshAnnotatedImage()
    }

    func undoAnnotation() {
        editSelectedFinding { $0.undo() }
        refreshAnnotatedImage()
    }

    func redoAnnotation() {
        editSelectedFinding { $0.redo() }
        refreshAnnotatedImage()
    }

    /// Every edit funnels through the core's session, which refuses edits
    /// to items filing has already touched. Edits also freeze while filing
    /// is in flight: the run works on a copy of the session, so a late
    /// edit would show in the preview yet be missing from the filed issue.
    private func editSelectedFinding(_ edit: (inout Finding) -> Void) {
        guard !isBusy, let selectedItemID else { return }
        session?.updateFinding(id: selectedItemID, edit)
    }

    private func refreshAnnotatedImage() {
        guard let finding = selectedItem?.finding else {
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

    /// Files every remaining Finding in the tray and lists the resulting
    /// issue links on the tray rows (PRD stories 24–25). This is the
    /// moment their Annotations stop being editable. Failure-safe: the
    /// core records every server-acknowledged step, so whatever filed
    /// stays marked and a retry files only the remainder.
    func fileAllFindings() async {
        guard let session, !hasPendingLabelDraft else { return }
        await perform {
            let outcome = await core.fileAll(in: session)
            self.session = outcome.session
            if let failure = outcome.failure { throw failure }
        }
    }

    /// True when file-all can run: something is left to file and every
    /// still-editable Finding has the summary filing requires.
    var canFileAll: Bool {
        guard let session, !isBusy, !hasPendingLabelDraft else { return false }
        let remaining = session.tray.filter { $0.filedIssue == nil }
        return !remaining.isEmpty && remaining.allSatisfy {
            !$0.isEditable || !$0.finding.summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    var remainingFindingCount: Int {
        session?.tray.count { $0.filedIssue == nil } ?? 0
    }

    private func clearSelection() {
        capturedImage = nil
        capturePixelSize = nil
        selectedItemID = nil
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
