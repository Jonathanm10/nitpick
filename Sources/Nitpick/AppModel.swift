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
    private let captureHotkey: CaptureHotkey
    private let recentDevicesStore = RecentDevicesStore()

    private(set) var build: Build?
    private(set) var devices: [SimulatorDevice] = []
    /// The designer's most-recently-reviewed devices, newest first — the
    /// picker's Recent section and the source of the launch preselection.
    /// Loaded from persistence at init, updated after every successful
    /// launch. Global across Builds (PRD out-of-scope: no per-Build MRU).
    private(set) var recentDevices: RecentDevices
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
    /// The Device Settings last observed at capture — the accessibility
    /// state read back from the simulator when the most recent Finding was
    /// stamped. nitpick no longer pushes these (ADR-0009); the designer
    /// drives accessibility in the simulator.
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
    var annotationTool: AnnotationTool = .pen {
        // Switching to any draw tool drops the selection — a stale
        // selection must never receive a stray keypress — and aborts any
        // in-flight move uncommitted.
        didSet {
            cancelAnnotationDrag()
            if annotationTool != .select { selectedAnnotationIndex = nil }
        }
    }
    /// The index of the Annotation selected with the Select tool —
    /// ephemeral workspace chrome: never persisted, never flattened into
    /// any PNG. Every editor-retargeting event clears it.
    private(set) var selectedAnnotationIndex: Int?
    /// The in-flight rigid move of the selected Annotation — nil except
    /// between the first cursor movement on the shape and release. Like
    /// the selection it belongs to, ephemeral workspace state.
    private(set) var annotationDrag: AnnotationDrag?
    var annotationColor: AnnotationColor = .default
    /// True only while the shell is inside file-all's core call — a
    /// dedicated run bit so the button phase can distinguish filing from
    /// unrelated busy work like device switches.
    private(set) var filingRunActive = false
    /// Remembers that the most recent file-all run came back with a
    /// failure, so the shell can say "File N remaining" until the next run
    /// starts and clears the comeback label.
    private(set) var filingStoppedByFailure = false
    private(set) var isBusy = false
    /// True while a text label is waiting for commit; every editor-retarget
    /// path keeps it intact so a visible draft never lands on the wrong row.
    var hasPendingLabelDraft = false
    var errorMessage: String?
    private(set) var designSnapshotErrorMessage: String?
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
    /// The capture hotkey follows this one property so every open/close
    /// edge stays in a single choke point; the stored value mutates often,
    /// but registration only cares whether a session exists.
    private(set) var session: ReviewSession? {
        didSet { captureHotkey.setActive(session != nil) }
    }
    /// The held result of a successful file-all run: the just-filed
    /// session as History's newest entry, shown in place until the designer
    /// chooses Done or drops the next Build. The live session has already
    /// ended and the capture hotkey is unregistered; this is transient,
    /// in-memory only, and never persisted (the session survives on disk as
    /// the newest History entry regardless).
    private(set) var filingResult: HistoryEntry?
    /// The local history log: filed sessions with their issue links,
    /// newest first. Read-only, read from disk — never from YouTrack.
    private(set) var history: [HistoryEntry] = []
    /// The chosen project's triage schema — its Priority scale — read once
    /// at Start review (glossary: Priority; ADR-0008). Held in memory for
    /// the session; the Editor's Priority control is populated from it, and
    /// an empty scale hides that control. Non-fatal to load.
    private(set) var sessionSchema = ProjectSchema()
    /// A transient toast naming any triage field filing had to drop and the
    /// value the designer intended, so it can be relayed by hand (PRD story
    /// 28). Set on a file-all that dropped a field; auto-clears. Never
    /// persisted — History stays a clean record.
    private(set) var droppedFieldNotice: String?

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

    /// The selected Finding's Type, bound to the Editor's Type control
    /// (glossary: Type). Always set — a fresh capture is a Bug — so the
    /// getter's fallback is only for the no-selection case the control is
    /// hidden in.
    var typeField: FindingType {
        get { selectedItem?.finding.type ?? .bug }
        set { editSelectedFinding { $0.type = newValue } }
    }

    /// The selected Finding's Priority, bound to the Editor's Priority
    /// picker (glossary: Priority). Optional — nil is "no Priority", a
    /// first-class choice that lets the Issue take the project's default.
    var priorityField: FindingPriority? {
        get { selectedItem?.finding.priority }
        set { editSelectedFinding { $0.priority = newValue } }
    }

    /// The selected Finding's Assignee, bound to the Editor's people-picker
    /// (glossary: Assignee). Optional — nil is unassigned, a valid state.
    var assigneeField: FindingAssignee? {
        get { selectedItem?.finding.assignee }
        set { editSelectedFinding { $0.assignee = newValue } }
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

    var designSnapshots: [DesignSnapshot] {
        selectedItem?.finding.designSnapshots ?? []
    }

    func addDesignSnapshots(from urls: [URL]) {
        guard !isBusy, let selectedItemID else { return }
        var files: [DesignSnapshotFile] = []
        var messages: [String] = []
        for url in urls {
            let accessed = url.startAccessingSecurityScopedResource()
            do {
                files.append(DesignSnapshotFile(name: url.lastPathComponent, data: try Data(contentsOf: url)))
            } catch {
                messages.append("\(url.lastPathComponent): \(error.localizedDescription)")
            }
            if accessed { url.stopAccessingSecurityScopedResource() }
        }
        do {
            let result = try session?.addDesignSnapshotFiles(files, to: selectedItemID)
            if result?.added.isEmpty == false { persistOpenSession() }
            messages += result?.rejected.map { "\($0.name): \($0.error.localizedDescription)" } ?? []
            designSnapshotErrorMessage = messages.isEmpty ? nil : messages.joined(separator: "\n")
        } catch {
            designSnapshotErrorMessage = error.localizedDescription
        }
    }

    func addPastedDesignSnapshot(_ png: Data) {
        guard !isBusy, let selectedItemID else { return }
        do {
            _ = try session?.addDesignSnapshot(
                to: selectedItemID,
                name: "Pasted Design \(designSnapshots.count + 1).png",
                mediaType: .png,
                data: png
            )
            persistOpenSession()
            designSnapshotErrorMessage = nil
        } catch {
            designSnapshotErrorMessage = error.localizedDescription
        }
    }

    func reportDesignSnapshotError(_ message: String) {
        designSnapshotErrorMessage = message
    }

    func renameDesignSnapshot(_ id: DesignSnapshot.ID, to name: String) {
        guard !isBusy, let selectedItemID else { return }
        do {
            try session?.renameDesignSnapshot(id, in: selectedItemID, to: name)
            persistOpenSession()
            designSnapshotErrorMessage = nil
        } catch {
            designSnapshotErrorMessage = error.localizedDescription
        }
    }

    func replaceDesignSnapshot(_ id: DesignSnapshot.ID, from url: URL) {
        guard !isBusy, let selectedItemID else { return }
        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }
        do {
            let mediaType = try DesignSnapshotMediaType(fileExtension: url.pathExtension)
            try session?.replaceDesignSnapshot(
                id,
                in: selectedItemID,
                mediaType: mediaType,
                data: Data(contentsOf: url)
            )
            persistOpenSession()
            designSnapshotErrorMessage = nil
        } catch {
            designSnapshotErrorMessage = error.localizedDescription
        }
    }

    func removeDesignSnapshot(_ id: DesignSnapshot.ID) {
        guard !isBusy, let selectedItemID else { return }
        do {
            try session?.removeDesignSnapshot(id, from: selectedItemID)
            persistOpenSession()
            designSnapshotErrorMessage = nil
        } catch {
            designSnapshotErrorMessage = error.localizedDescription
        }
    }

    /// A pasted Figma URL, or nil when the field is blank — absent is a
    /// first-class state at both levels, never an error.
    private static func designReference(from text: String) -> URL? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : URL(string: trimmed)
    }

    init(
        core: AppCore = AppCore(environment: .live(), workspaceDirectory: AppModel.defaultWorkspaceDirectory()),
        captureHotkey: CaptureHotkey = CaptureHotkey()
    ) {
        self.core = core
        self.captureHotkey = captureHotkey
        recentDevices = recentDevicesStore.load()
        captureHotkey.onPress = { [weak self] in
            Task { [weak self] in
                guard let self else { return }
                await self.captureFromHotkey()
            }
        }
    }
    
    deinit {
        let hotkey = captureHotkey
        Task { @MainActor in
            hotkey.setActive(false)
        }
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
            && filingResult == nil
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
            // dead with no explanation — reselect: the most-recent
            // still-available device, else the first usable one (PRD
            // preselection). A first launch (no selection yet) preselects
            // the same way.
            if selectedDevice?.isRuntimeAvailable != true {
                selectedDeviceID = recentDevices.preferredDevice(among: devices)?.id
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
            // connection that lacks it. A held filing result must be cleared
            // before the restored session becomes live again, so the shell
            // shows only one truth at a time.
            if let youTrack, !youTrack.projects.contains(restored.project) { return }
            filingResult = nil
            filingStoppedByFailure = false
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
            // A Build dropped onto the in-place filing result dismisses it:
            // the next review starts from the plain home drop zone, exactly
            // as a drop on home does (issue 03). Already nil on home.
            filingResult = nil
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
            try await core.launch(build, on: device)
            reviewDevice = device
            recordRecentDevice(device)
            isReviewing = true
            // Session-setup schema read (ADR-0008): learn the project's
            // Priority scale so the Editor's control is populated before the
            // first capture. Non-fatal — an empty schema hides the control,
            // and capture and filing proceed regardless (PRD story 22).
            sessionSchema = await core.loadProjectSchema(for: project)
            if session == nil {
                filingResult = nil
                filingStoppedByFailure = false
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
    /// Build on the new device. The session — Build, project, tray — is
    /// untouched. On failure the picker reverts to the device still running
    /// the Build.
    func switchDevice(to id: SimulatorDevice.ID?) async {
        guard isReviewing, !isBusy, let build,
              let id, id != reviewDevice?.id,
              let device = devices.first(where: { $0.id == id }),
              device.isRuntimeAvailable
        else { return }
        selectedDeviceID = id
        await perform {
            do {
                try await core.launch(build, on: device)
                reviewDevice = device
                recordRecentDevice(device)
            } catch {
                selectedDeviceID = reviewDevice?.id
                throw error
            }
        }
    }

    /// Records a successful launch on `device` in the MRU and persists it
    /// (PRD story 4/11): session start or a switch that succeeded. Never
    /// called on mere selection or a reverted switch, so a stray click
    /// cannot pollute Recent.
    private func recordRecentDevice(_ device: SimulatorDevice) {
        recentDevices.record(device.udid)
        recentDevicesStore.save(recentDevices)
    }

    /// Runs the existing capture path and reports whether it actually
    /// landed. The hotkey uses the signal to decide whether Nitpick should
    /// steal focus; a refused capture must leave the designer where they are.
    @discardableResult
    func captureScreen() async -> Bool {
        // A pending label draft pins the editor: retargeting before the
        // surface resolves it would drop the visible note or commit it to
        // the wrong Finding — same invariant as the filing gate. Busy means
        // a device switch may be in flight — capturing then
        // could stamp a Device Context the screenshot wasn't taken under.
        guard canCapture, let device = reviewDevice else { return false }
        var didCapture = false
        await perform {
            do {
                let png = try await core.captureScreen(of: device)
                // Read the simulator's live accessibility state now, so the
                // Finding is stamped with exactly the conditions the
                // screenshot was taken under (ADR-0009).
                deviceSettings = try await core.observedSettings(of: device)
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
                selectedAnnotationIndex = nil
                annotationDrag = nil
                // The surface resets its live draft off captureID, but if it
                // was unmounted first its onChange never fires — the model
                // owns the gate, so the model resets it.
                hasPendingLabelDraft = false
                refreshAnnotatedImage()
                didCapture = true
            } catch {
                // A capture refused because the device is gone means the
                // designer closed the simulator under the session: the
                // review pauses into the restored-session state — session
                // and tray intact, Resume review relaunches the Build.
                if case SimulatorError.deviceNotBooted = error {
                    isReviewing = false
                    reviewDevice = nil
                }
                throw error
            }
        }
        return didCapture
    }

    /// Sends the designer back to the Build — v1 targets Simulator.app
    /// concretely. The editor uses this as the one "return to the Build"
    /// action, so the shell stays thin and the platform swap remains a
    /// single core-side decision.
    @discardableResult
    func returnToBuild() -> Bool {
        guard let simulator = NSRunningApplication
            .runningApplications(withBundleIdentifier: "com.apple.iphonesimulator")
            .first
        else { return false }
        return simulator.activate(options: [.activateAllWindows])
    }

    /// The hotkey follows the same capture path as ⌘S, then only on
    /// success brings Nitpick forward to the session window.
    private func captureFromHotkey() async {
        guard await captureScreen() else { return }
        NSApp.activate(ignoringOtherApps: true)
        NSApp.mainWindow?.makeKeyAndOrderFront(nil)
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
            filingRunActive = true
            filingStoppedByFailure = false
            droppedFieldNotice = nil
            let outcome = await core.fileAll(in: session, onProgress: { self.session = $0 })
            filingRunActive = false
            // Report any triage fields the run had to drop (PRD story 28,
            // ADR-0008) before anything else: a field dropped on an
            // already-filed Finding must still surface even when a later
            // Finding stops the run — the drop won't recur on retry.
            presentDroppedFieldNotice(from: outcome.droppedFields)
            if let failure = outcome.failure {
                filingStoppedByFailure = true
                self.session = outcome.session
                refreshHistory()
                throw failure
            }

            // The whole tray filed: the live Review Session is over. End it
            // — the capture hotkey unregisters as `session` clears, the
            // device is dropped — and hold the just-filed session as the
            // in-place result: History's newest entry, shown read-only until
            // the designer chooses Done or drops the next Build (PRD stories
            // 1, 2, 25). No timer; nothing disappears on its own. The held
            // result is transient and in-memory — the session survives on
            // disk as the newest History entry regardless.
            self.session = nil
            isReviewing = false
            reviewDevice = nil
            sessionSchema = ProjectSchema()
            clearSelection()
            // Re-read History from disk and hold its newest entry — the
            // session that just filed (its start moment is the latest, so it
            // sorts to the head). A throwing read means a successful file-all
            // never shows a stale or empty row: the error surfaces and the
            // shell falls back to plain home, the session safe on disk.
            history = try core.sessionHistory()
            filingResult = history.first
        }
    }
    private func endSession(clearingPersisted: Bool) throws {
        session = nil
        isReviewing = false
        reviewDevice = nil
        // The session's triage schema and any dropped-field notice belong
        // to this session; the next one reads a fresh schema at Start review.
        sessionSchema = ProjectSchema()
        droppedFieldNotice = nil
        // The comeback label belongs to the run that failed — a session
        // ending takes it along, or the next session would open on a
        // stale "File N remaining".
        filingStoppedByFailure = false
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
    /// The live session's filing phase — what the File all button shows.
    /// Only a live session has a File all button; the held filing result is
    /// a read-only History row, so it needs no phase.
    var filingPhase: FilingPhase? {
        session?.filingPhase(
            isRunning: filingRunActive,
            stoppedByFailure: filingStoppedByFailure
        )
    }

    /// Done on the in-place filing result: clear the held result and return
    /// to the plain home drop zone. The Build stays loaded, so starting the
    /// next review is the normal home entry point; the just-filed session is
    /// untouched on disk as History's newest entry.
    func dismissFilingResult() {
        filingResult = nil
    }

    /// The toast's own dismissal (its auto-hide timer, or a click): clears
    /// the notice. Presentation only — nothing else depends on it.
    func dismissDroppedFieldNotice() {
        droppedFieldNotice = nil
    }

    /// Builds the dropped-field toast from a file-all outcome: names each
    /// distinct field + intended value once, so the designer can relay them
    /// by hand. No dropped fields leaves the notice clear.
    private func presentDroppedFieldNotice(from dropped: [TrayItem.ID: [DroppedTriageField]]) {
        let all = dropped.values.flatMap { $0 }
        guard !all.isEmpty else { return }
        let phrases = Set(all.map { "\($0.field.label) “\($0.intendedValue)”" }).sorted()
        let list = phrases.joined(separator: ", ")
        droppedFieldNotice = all.count == 1
            ? "Couldn’t set \(list) — set it in YouTrack by hand."
            : "Couldn’t set some triage fields (\(list)) — set them in YouTrack by hand."
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
        selectedAnnotationIndex = nil
        annotationDrag = nil
        hasPendingLabelDraft = false
        designSnapshotErrorMessage = nil
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

// MARK: - Tray selection and Annotation editing (state lives in the core's session)

extension AppModel {
    var canUndoAnnotation: Bool { selectedItem?.finding.canUndo ?? false }
    var canRedoAnnotation: Bool { selectedItem?.finding.canRedo ?? false }

    var annotationMetrics: AnnotationMetrics? {
        capturePixelSize.map(AnnotationMetrics.init(imageSize:))
    }

    /// Opens a tray item in the editor. Refused while a label draft is
    /// pending: the surface still owns the typed text, and retargeting
    /// first would land its commit on the wrong Finding.
    func selectItem(_ id: TrayItem.ID) {
        guard session != nil, selectedItemID != id, !hasPendingLabelDraft else { return }
        selectedItemID = id
        captureID = UUID()
        selectedAnnotationIndex = nil
        annotationDrag = nil
        hasPendingLabelDraft = false
        designSnapshotErrorMessage = nil
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

    /// Esc in the Editor, one rule for every focus scope (PRD stories 10,
    /// 11): an in-flight or selected Annotation is released first;
    /// otherwise a pristine Finding — the mis-capture case — dies
    /// instantly. The core's predicate decides pristine.
    func handleEditorEscape() {
        if annotationDrag != nil || selectedAnnotationIndex != nil {
            deselectAnnotation()
        } else if let item = selectedItem, item.isPristine {
            discardFinding(id: item.id)
        }
    }

    /// Whether Esc would act from the annotation surface's own focus
    /// scope: release an in-flight or selected Annotation first, else the
    /// pristine discard. The shell installs its Esc handler only when
    /// true — an installed no-op would still consume the command.
    var editorEscapeWouldAct: Bool {
        annotationDrag != nil || selectedAnnotationIndex != nil || editorEscapeWouldDiscard
    }

    /// Whether Esc would act from the editor scope at large, where a text
    /// field may hold focus: only the pristine mis-capture discard.
    /// Releasing an Annotation selection belongs to the surface's focus
    /// scope — Esc in Summary or Description must keep standard field
    /// behavior (PRD story 11). Mirrors `discardFinding`'s guards.
    var editorEscapeWouldDiscard: Bool {
        !isBusy && !hasPendingLabelDraft && selectedItem?.isPristine == true
    }

    func addAnnotation(_ shape: Annotation.Shape) {
        editSelectedFinding { $0.add(Annotation(shape, color: annotationColor)) }
        refreshAnnotatedImage()
    }

    func undoAnnotation() {
        // History moves indices arbitrarily — a stale selection must
        // never point Delete at the wrong Annotation.
        selectedAnnotationIndex = nil
        annotationDrag = nil
        editSelectedFinding { $0.undo() }
        refreshAnnotatedImage()
    }

    func redoAnnotation() {
        selectedAnnotationIndex = nil
        annotationDrag = nil
        editSelectedFinding { $0.redo() }
        refreshAnnotatedImage()
    }

    /// The selected Annotation itself, bounds-checked so the shell's
    /// indicator can never read past a mutated array.
    var selectedAnnotation: Annotation? {
        guard let index = selectedAnnotationIndex,
              let annotations = selectedItem?.finding.annotations,
              annotations.indices.contains(index)
        else { return nil }
        return annotations[index]
    }

    /// The topmost committed Annotation under an image-pixel point,
    /// with the same core hit test the Select tool clicks with — the
    /// right-click menu asks it before offering Delete.
    func annotationIndex(at point: CGPoint) -> Int? {
        guard let finding = selectedItem?.finding, let metrics = annotationMetrics else { return nil }
        return finding.annotationIndex(at: point, metrics: metrics)
    }

    /// A Select-tool click, in image pixels: selects the topmost
    /// Annotation under the point, or — on empty surface — deselects.
    func selectAnnotation(at point: CGPoint) {
        selectedAnnotationIndex = annotationIndex(at: point)
    }

    func deselectAnnotation() {
        cancelAnnotationDrag()
        selectedAnnotationIndex = nil
    }

    /// Delete/Backspace on the selection.
    func deleteSelectedAnnotation() {
        guard let index = selectedAnnotationIndex else { return }
        deleteAnnotation(at: index)
    }

    /// One core removal, one undo step — ⌘Z brings the Annotation back.
    /// Reached by Delete/Backspace on the selection and by right-click →
    /// Delete under any tool. Bounds-checked against the current
    /// Annotations, not the caller's snapshot — a context menu holds its
    /// index for as long as it stays open. A selection elsewhere
    /// survives: removal shifts later indices down by one.
    func deleteAnnotation(at index: Int) {
        guard !isBusy, let annotations = selectedItem?.finding.annotations,
              annotations.indices.contains(index)
        else { return }
        cancelAnnotationDrag()
        if let selected = selectedAnnotationIndex {
            if selected == index {
                selectedAnnotationIndex = nil
            } else if selected > index {
                selectedAnnotationIndex = selected - 1
            }
        }
        editSelectedFinding { $0.removeAnnotation(at: index) }
        refreshAnnotatedImage()
    }

    /// An arrow-key nudge: translates the selection one `strokeWidth` —
    /// the mark's own visual grain, so the step tracks capture
    /// resolution — times `multiplier` (Shift's 5×), through the same
    /// translation helper the drag uses. Each press commits one
    /// `replaceAnnotation` — one undo step; no coalescing. Ignored
    /// mid-drag: the cursor owns the shape until release.
    func nudgeSelectedAnnotation(_ direction: CGVector, multiplier: CGFloat = 1) {
        guard !isBusy, annotationDrag == nil,
              let index = selectedAnnotationIndex,
              let annotation = selectedAnnotation,
              let metrics = annotationMetrics
        else { return }
        let step = metrics.strokeWidth * multiplier
        editSelectedFinding {
            $0.replaceAnnotation(
                at: index,
                with: annotation.translated(by: CGVector(dx: direction.dx * step, dy: direction.dy * step))
            )
        }
        refreshAnnotatedImage()
    }

    /// A rigid move of the selected Annotation, in flight from the first
    /// cursor movement on the shape until release. The shape leaves the
    /// flattened base (exclude-one render) and rides as a renderer-drawn
    /// overlay the view shifts — never double-drawn, never ghosted at its
    /// old position. While held it composites above the whole base, so a
    /// mid-stack shape shows over later marks for the drag's duration;
    /// release re-renders true stacking.
    struct AnnotationDrag {
        let index: Int
        /// The Annotation as the drag found it — release translates this,
        /// and commits only if it is still in place.
        let annotation: Annotation
        /// The shape alone on transparency at its pre-drag position,
        /// rendered by the core so the preview is pixel truth.
        let overlayImage: NSImage
        /// Whole image pixels — rounded on update, the single source for
        /// the live preview and the committed move alike.
        var offset = CGVector.zero
    }

    /// Begins a rigid move when `point` (image pixels) falls on the
    /// selected Annotation; returns whether the move owns the gesture.
    func beginAnnotationDrag(at point: CGPoint) -> Bool {
        cancelAnnotationDrag()  // heals a drag orphaned by a cancelled gesture
        guard !isBusy,
              let index = selectedAnnotationIndex,
              let annotation = selectedAnnotation,
              let metrics = annotationMetrics,
              let pixelSize = capturePixelSize,
              annotation.hitTest(point, metrics: metrics),
              let overlay = annotation.renderedAlone(canvasSize: pixelSize)
        else { return false }
        annotationDrag = AnnotationDrag(
            index: index,
            annotation: annotation,
            overlayImage: NSImage(cgImage: overlay, size: pixelSize)
        )
        refreshAnnotatedImage(excludingAnnotationAt: index)
        return true
    }

    /// Tracks the cursor. The offset rounds to whole pixels so the
    /// shifted overlay stays pixel-identical to what release flattens —
    /// rendering is translation-invariant on the pixel lattice, and the
    /// rounded value is what preview and commit alike use.
    func updateAnnotationDrag(offset: CGVector) {
        annotationDrag?.offset = CGVector(dx: offset.dx.rounded(), dy: offset.dy.rounded())
    }

    /// Release: the whole move is one `replaceAnnotation` — one undo
    /// step, ⌘Z returns the shape to its pre-drag position. Commits only
    /// if the dragged Annotation still stands where the drag found it;
    /// an interleaved mutation (an undo mid-drag) drops the move rather
    /// than landing it on the wrong shape.
    func endAnnotationDrag() {
        guard let drag = annotationDrag else { return }
        annotationDrag = nil
        if drag.offset.dx != 0 || drag.offset.dy != 0,
           let annotations = selectedItem?.finding.annotations,
           annotations.indices.contains(drag.index),
           annotations[drag.index] == drag.annotation {
            editSelectedFinding {
                $0.replaceAnnotation(at: drag.index, with: drag.annotation.translated(by: drag.offset))
            }
        }
        refreshAnnotatedImage()
    }

    /// Abandons an in-flight move without committing — the base returns
    /// to the full render, the shape to its pre-drag position.
    func cancelAnnotationDrag() {
        guard annotationDrag != nil else { return }
        annotationDrag = nil
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

    private func refreshAnnotatedImage(excludingAnnotationAt excluded: Int? = nil) {
        guard let finding = selectedItem?.finding else {
            capturedImage = nil
            capturePixelSize = nil
            return
        }
        if let image = try? finding.annotatedScreenshotImage(excludingAnnotationAt: excluded) {
            capturedImage = NSImage(cgImage: image, size: NSSize(width: image.width, height: image.height))
            capturePixelSize = CGSize(width: image.width, height: image.height)
        } else {
            // An undecodable capture: show nothing rather than lie; filing
            // will surface the real error.
            capturedImage = NSImage(data: finding.screenshotPNG)
            capturePixelSize = capturedImage.map { CGSize(width: $0.size.width, height: $0.size.height) }
        }
    }
}
