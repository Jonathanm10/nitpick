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
    /// What this Mac is missing before a review can run (issue 10):
    /// non-nil shows the guided-setup panel instead of the device picker.
    /// Refreshed at launch, on every Build drop, at session start, and by
    /// the panel's own "Check again".
    private(set) var setupGuidance: SetupGuidance?
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
    /// Menu commands live outside ContentView, so the End Review confirmation
    /// flag sits on the model where both the window and the menu can drive it.
    var endReviewConfirmationRequested = false

    /// The verified YouTrack connection; nil shows the first-run settings.
    private(set) var youTrack: YouTrackConnection?
    var youTrackInstanceURLField = ""
    var youTrackTokenField = ""
    var selectedProjectID: YouTrackProject.ID?
    var youTrackErrorMessage: String?

    /// The active Review Session: Build + project pinned at Start review,
    /// and the session tray its captures accumulate in.
    private(set) var session: ReviewSession?
    /// The local history log: filed sessions with their issue links,
    /// newest first. Read-only, read from disk — never from YouTrack.
    private(set) var history: [HistoryEntry] = []

    var historyTrace: HistoryTrace? {
        HistoryTrace(history: history)
    }

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

    /// The session-level Design Reference (issue 09), bound to the review
    /// section's field — the Figma URL every Finding files under unless it
    /// carries its own. Guarded like every Finding edit: filing works on a
    /// copy of the session, so a mid-flight edit would be silently lost.
    var sessionDesignReferenceField: String {
        get { session?.designReference?.absoluteString ?? "" }
        set {
            guard !isBusy, session != nil else { return }
            session?.designReference = Self.designReference(from: newValue)
            persistOpenSession()
        }
    }

    /// The selected Finding's own Design Reference — overrides the
    /// session-level one for that Finding only.
    var findingDesignReferenceField: String {
        get { selectedItem?.finding.designReference?.absoluteString ?? "" }
        set { editSelectedFinding { $0.designReference = Self.designReference(from: newValue) } }
    }

    /// A pasted Figma URL, or nil when the field is blank — absent is a
    /// first-class state at both levels, never an error.
    private static func designReference(from text: String) -> URL? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : URL(string: trimmed)
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

    var startReviewTitle: String { session == nil ? "Start review" : "Resume review" }

    /// Mirrored by the window's Start/Resume button and the Review menu
    /// item — the hero group shows the button before a Build exists, so
    /// the Build is part of the predicate, keeping the menu honest too.
    var canStartReview: Bool {
        build != nil
            && !isReviewing
            && selectedDevice?.isRuntimeAvailable == true
            && (session != nil || selectedProject != nil)
            && !isBusy
    }

    var canCapture: Bool { isReviewing && !isBusy && !hasPendingLabelDraft }

    var canEndReview: Bool { session != nil && !isBusy }

    var selectedProject: YouTrackProject? {
        youTrack?.projects.first { $0.id == selectedProjectID }
    }

    /// Everything a relaunch brings back, in order: the saved YouTrack
    /// connection, the prerequisite check (a missing Xcode surfaces as
    /// guidance before the designer invests anything), then the open
    /// session a quit or crash left behind (its project checked against
    /// that connection), then the history log.
    func onLaunch() async {
        await loadYouTrack()
        await perform { try await refreshSetup() }
        await restoreOpenSession()
        refreshHistory()
    }

    /// Runs the core's prerequisite probe and publishes its outcome: the
    /// guidance panel when something is missing, the pickable devices when
    /// ready. Returns whether the Mac is ready to review.
    @discardableResult
    private func refreshSetup() async throws -> Bool {
        switch try await core.checkSetup() {
        case .ready(let devices):
            setupGuidance = nil
            self.devices = devices
            // A selection whose runtime vanished would leave Start review
            // dead with no explanation — move to the first usable device.
            if selectedDevice?.isRuntimeAvailable != true {
                selectedDeviceID = devices.first { $0.isRuntimeAvailable }?.id
            }
            return true
        case .needsSetup(let guidance):
            setupGuidance = guidance
            devices = []
            return false
        }
    }

    /// The guidance panel's "Check again" — re-probes after the designer
    /// installs the missing piece.
    func recheckSetup() async {
        await perform { try await refreshSetup() }
    }

    /// The resume path (issue 07): the open session comes back with its
    /// tray, descriptions, and still-editable Annotations. The simulator
    /// is not relaunched — Resume review does that on demand; filing works
    /// straight away.
    private func restoreOpenSession() async {
        await perform {
            guard let restored = try core.loadOpenSession() else { return }
            // Filing must never pair the session's pinned project with a
            // connection that lacks it (an entity-id collision across
            // instances could file into a stranger's project). The session
            // stays on disk; reconnecting to the right instance revives it
            // on the next launch. Not connected yet is fine — `connected`
            // applies the same check later.
            if let youTrack, !youTrack.projects.contains(restored.project) { return }
            session = restored
            build = restored.build
            selectedProjectID = restored.project.id
        }
    }

    /// The relaunch path: resume a saved connection, prefilling the
    /// instance URL either way.
    func loadYouTrack() async {
        await perform(reportingTo: \.youTrackErrorMessage) {
            if let url = try core.youTrackInstanceURL() {
                youTrackInstanceURLField = url.absoluteString
            }
            guard let connection = try await core.reconnectYouTrack() else { return }
            try connected(connection)
        }
    }

    func connectYouTrack() async {
        await perform(reportingTo: \.youTrackErrorMessage) {
            let connection = try await core.connectYouTrack(
                instanceURL: youTrackInstanceURLField,
                token: youTrackTokenField
            )
            youTrackTokenField = ""
            try connected(connection)
        }
    }

    /// Back to the settings form, e.g. to point at another instance or paste
    /// a fresh token. The saved connection stays until the next connect.
    func editYouTrackConnection() {
        youTrack = nil
        youTrackErrorMessage = nil
    }

    private func connected(_ connection: YouTrackConnection) throws {
        // A connection change ends the active Review Session unless this
        // connection offers the session's exact project (id, key, and
        // name) — filing must never pair the pinned project with
        // credentials it wasn't chosen under. Reconnecting to the same
        // instance keeps the session; its open-session file stays on disk
        // either way, so ending it here never destroys review work.
        if let session, !connection.projects.contains(session.project) {
            try endSession(clearingPersisted: false)
        }
        // A surviving session's pinned project drives the (disabled)
        // picker. Otherwise keep the picker's choice only when the
        // identical project (id, key, and name) exists on this
        // connection — an entity-id collision across instances must not
        // silently select a different project.
        let previous = selectedProject
        youTrack = connection
        if let session {
            selectedProjectID = session.project.id
        } else if previous == nil || !connection.projects.contains(where: { $0 == previous }) {
            selectedProjectID = connection.projects.first?.id
        }
    }

    func ingest(_ url: URL) async {
        await perform {
            build = try await core.ingestBuild(at: url)
            isReviewing = false
            reviewDevice = nil
            // A successful drag of a new Build ends any open session (a
            // Review Session reviews exactly one Build) — on disk too, or
            // a relaunch would resurrect what the designer deliberately
            // left. An invalid drop throws above and costs nothing.
            if session != nil {
                try endSession(clearingPersisted: true)
            }
            try await refreshSetup()
        }
    }

    /// Starts the Review Session: launches the Build and pins the chosen
    /// project exactly once — filing never re-asks (PRD session boundary:
    /// a Review Session always pairs Build + project). A restored session
    /// resumes instead: its pinned project and tray stay; only the
    /// simulator is relaunched.
    func startReview() async {
        guard canStartReview, let build, let project = session?.project ?? selectedProject else { return }
        await perform {
            // Session-start prerequisite check (issue 10): a missing Xcode
            // or runtime surfaces as guidance before any boot is attempted.
            guard try await refreshSetup() else { return }
            guard let device = selectedDevice, device.isRuntimeAvailable else { return }
            // Every session starts from default Device Settings; launch
            // applies them, so the stamp matches the simulator from the
            // first capture on.
            let settings = DeviceSettings()
            try await core.launch(build, on: device, settings: settings)
            deviceSettings = settings
            reviewDevice = device
            isReviewing = true
            if session == nil {
                session = ReviewSession(build: build, project: project)
                clearSelection()
                persistOpenSession()
            }
        }
    }

    /// Routes End Review from the button and the menu: confirm if unfiled
    /// Findings would be discarded, otherwise end immediately.
    func requestEndReview() {
        guard canEndReview else { return }
        if session?.hasUnfiledFindings == true {
            endReviewConfirmationRequested = true
        } else {
            Task { await endReview() }
        }
    }

    /// Ends the Review Session without filing. The Build stays loaded,
    /// the shell returns to its no-session state, and History is untouched.
    func endReview() async {
        guard canEndReview else { return }
        await perform {
            try endSession(clearingPersisted: true)
        }
    }
    /// Mid-session device switch (PRD story 7): relaunches the session's
    /// Build on the new device under the session's current Device Settings.
    /// The session — Build, project, tray — is untouched. On failure the
    /// picker reverts to the device still running the Build.
    func switchDevice(to id: SimulatorDevice.ID?) async {
        guard isReviewing, !isBusy, let build,
              let id, id != reviewDevice?.id,
              let device = devices.first(where: { $0.id == id }),
              device.isRuntimeAvailable
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
        guard canCapture, let device = reviewDevice else { return }
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
            persistOpenSession()
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
        persistOpenSession()
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
        persistOpenSession()
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

    /// Files every remaining Finding in the tray — the moment their
    /// Annotations stop being editable (PRD story 24). Failure-safe and
    /// crash-safe: the core records every server-acknowledged step on
    /// disk, so whatever filed stays marked — even across a relaunch —
    /// and a retry files only the remainder. When the whole tray files,
    /// the Review Session is over: it becomes a read-only history entry
    /// where its issue links stay visible (PRD story 25), and the next
    /// review starts fresh.
    func fileAllFindings() async {
        guard canFileAll, let session else { return }
        await perform {
            let outcome = await core.fileAll(in: session)
            if outcome.failure == nil {
                self.session = nil
                isReviewing = false
                reviewDevice = nil
                clearSelection()
            } else {
                self.session = outcome.session
            }
            refreshHistory()
            if let failure = outcome.failure { throw failure }
        }
    }
    private func endSession(clearingPersisted: Bool) throws {
        session = nil
        isReviewing = false
        reviewDevice = nil
        if clearingPersisted {
            try core.clearOpenSession()
        }
        clearSelection()
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

    /// The core's unfiled count — what "File all (n)" shows and the drop
    /// guard's confirmation names.
    var unfiledFindingCount: Int {
        session?.unfiledFindingCount ?? 0
    }

    /// Sessions persist as they are created (issue 07): every mutation
    /// lands on disk before the designer's next action, so a quit or crash
    /// costs nothing.
    private func persistOpenSession() {
        guard let session else { return }
        do {
            try core.saveOpenSession(session)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func refreshHistory() {
        do {
            history = try core.sessionHistory()
        } catch {
            errorMessage = error.localizedDescription
        }
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
