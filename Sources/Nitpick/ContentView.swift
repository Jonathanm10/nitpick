import NitpickCore
import SwiftUI

struct ContentView: View {
    @Bindable var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let session = model.session {
                sessionHeader(session)
            } else {
                youTrackSection
                Divider()
                dropZone
            }
            if let guidance = model.setupGuidance {
                setupGuidanceSection(guidance)
            } else if model.build != nil {
                deviceRow
            }
            if model.session != nil {
                sessionSplit
            }
            if let message = model.errorMessage {
                Text(message)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }
            if model.session == nil {
                Spacer(minLength: 0)
                historySection
            }
        }
        .padding(20)
        .frame(minWidth: 520, minHeight: 640)
        // One-shot window growth at Start review (issue 03): fires on the
        // session's closed→open edge — nothing mid-loop reopens a session.
        .background(SessionWindowGrowth(isSessionOpen: model.session != nil))
        .dropDestination(for: URL.self) { urls, _ in
            guard let url = urls.first else { return false }
            Task { await model.ingest(url) }
            return true
        }
        .task { await model.onLaunch() }
        .overlay(alignment: .topTrailing) {
            if model.isBusy {
                ProgressView()
                    .controlSize(.small)
                    .padding(24)
            }
        }
    }

    @ViewBuilder
    private var youTrackSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let connection = model.youTrack {
                HStack(spacing: 12) {
                    Text("Connected as \(connection.user.fullName) (\(connection.user.login))")
                    Spacer()
                    Button("Change…") { model.editYouTrackConnection() }
                }
                Picker("Project", selection: $model.selectedProjectID) {
                    ForEach(connection.projects) { project in
                        Text("\(project.name) (\(project.shortName))")
                            .tag(Optional(project.id))
                    }
                }
                .frame(maxWidth: 320, alignment: .leading)
                // The session pins its project at Start review; filing
                // never re-asks. A new choice takes effect next session.
                .disabled(model.session != nil)
            } else {
                Text("Connect to YouTrack")
                    .font(.headline)
                TextField("Instance URL (https://youtrack.example.com)", text: $model.youTrackInstanceURLField)
                    .textContentType(.URL)
                    .autocorrectionDisabled()
                SecureField("Permanent token", text: $model.youTrackTokenField)
                Button("Connect") {
                    Task { await model.connectYouTrack() }
                }
                .disabled(
                    model.youTrackInstanceURLField.isEmpty
                        || model.youTrackTokenField.isEmpty
                        || model.isBusy
                )
            }
            if let message = model.youTrackErrorMessage {
                Text(message)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }
        }
    }

    private var dropZone: some View {
        RoundedRectangle(cornerRadius: 12)
            .strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [6]))
            .foregroundStyle(.secondary)
            .frame(height: 96)
            .overlay {
                if let build = model.build {
                    VStack(spacing: 4) {
                        Text(build.appBundleURL.deletingPathExtension().lastPathComponent)
                            .font(.headline)
                        Text("\(build.identity.bundleID) \(build.identity.version) (\(build.identity.buildNumber))")
                            .font(.callout.monospaced())
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                } else {
                    Text("Drop a simulator Build (.app or .zip)")
                        .foregroundStyle(.secondary)
                }
            }
    }

    /// The collapsed setup chrome (issue 02): while a session is open, one
    /// line names what is under review and where its Findings will file —
    /// app, version, build number, project. Nothing interactive is lost:
    /// the project is pinned at Start review and the picker is disabled
    /// mid-session anyway. The full block and drop zone return with the
    /// next session-less state.
    private func sessionHeader(_ session: ReviewSession) -> some View {
        HStack(spacing: 6) {
            Text(session.build.appBundleURL.deletingPathExtension().lastPathComponent)
                .font(.headline)
            Text("\(session.build.identity.version) (\(session.build.identity.buildNumber)) · \(session.project.name)")
                .foregroundStyle(.secondary)
        }
        .lineLimit(1)
    }

    /// Before the review: pick a device and start. During the review: the
    /// same picker switches the running Build to another device, and the
    /// Device Context controls set Dynamic Type and appearance — all
    /// stamped onto the next capture.
    private var deviceRow: some View {
        HStack(spacing: 12) {
            Picker("Device", selection: deviceSelection) {
                ForEach(model.devices) { device in
                    // A device whose runtime is missing is flagged at pick
                    // time — visible but not selectable (issue 10).
                    Text(
                        device.isRuntimeAvailable
                            ? "\(device.name) — \(device.osName)"
                            : "\(device.name) — \(device.osName) (runtime missing)"
                    )
                    .tag(Optional(device.id))
                    .selectionDisabled(!device.isRuntimeAvailable)
                }
            }
            .labelsHidden()
            .disabled(model.isBusy)

            if model.isReviewing {
                Picker("Dynamic Type", selection: dynamicTypeSelection) {
                    ForEach(DeviceSettings.DynamicTypeSize.allCases, id: \.self) { size in
                        Text(size.displayName).tag(size)
                    }
                }
                .fixedSize()
                .disabled(model.isBusy)
                .help("The simulator's Dynamic Type size — stamped onto every capture.")

                Picker("Appearance", selection: appearanceSelection) {
                    Text("Light").tag(DeviceSettings.Appearance.light)
                    Text("Dark").tag(DeviceSettings.Appearance.dark)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                .disabled(model.isBusy)
                .help("The simulator's appearance — stamped onto every capture.")
            } else {
                // A restored session resumes with its pinned project;
                // a fresh start needs the picker's choice.
                Button(model.session == nil ? "Start review" : "Resume review") {
                    Task { await model.startReview() }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(
                    model.selectedDevice?.isRuntimeAvailable != true
                        || (model.selectedProject == nil && model.session == nil)
                        || model.isBusy
                )
                .help("Reviewing needs a device and a YouTrack project — the session files into it.")
            }
        }
    }

    /// The guided-setup panel (issue 10): what's missing on this Mac and
    /// the install path, in the designer's language — shown in place of
    /// the device picker until "Check again" comes back clean.
    private func setupGuidanceSection(_ guidance: SetupGuidance) -> some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                Label(guidance.title, systemImage: "wrench.and.screwdriver")
                    .font(.headline)
                ForEach(Array(guidance.steps.enumerated()), id: \.offset) { index, step in
                    Text("\(index + 1). \(step)")
                        .foregroundStyle(.secondary)
                }
                Button("Check again") {
                    Task { await model.recheckSetup() }
                }
                .disabled(model.isBusy)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(4)
        }
    }

    /// Mid-session, choosing a device is a switch: the model relaunches the
    /// Build and reverts the selection if the switch fails.
    private var deviceSelection: Binding<SimulatorDevice.ID?> {
        Binding(
            get: { model.selectedDeviceID },
            set: { id in
                if model.isReviewing {
                    Task { await model.switchDevice(to: id) }
                } else {
                    model.selectedDeviceID = id
                }
            }
        )
    }

    private var dynamicTypeSelection: Binding<DeviceSettings.DynamicTypeSize> {
        Binding(
            get: { model.deviceSettings.dynamicTypeSize },
            set: { size in Task { await model.setDynamicTypeSize(size) } }
        )
    }

    private var appearanceSelection: Binding<DeviceSettings.Appearance> {
        Binding(
            get: { model.deviceSettings.appearance },
            set: { appearance in Task { await model.setAppearance(appearance) } }
        )
    }

    /// The open session, split (issue 01): the capture pane fills the
    /// left side at full height — the annotation toolbar directly above
    /// the annotated capture — and every session control stacks in a
    /// fixed-width column on the right. Shown whenever a session exists —
    /// including one restored after a relaunch, before its Build is
    /// launched again.
    private var sessionSplit: some View {
        HStack(alignment: .top, spacing: 16) {
            capturePane
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            controlColumn
                .frame(width: 320, alignment: .topLeading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    /// The full-size pane: the selected Finding under edit, or — once
    /// filed — the same capture frozen at the same size, no edits. The
    /// hidden toolbar keeps the editable layout's slot, so selecting
    /// between editable and frozen rows never resizes the image.
    @ViewBuilder
    private var capturePane: some View {
        if let item = model.selectedItem {
            if item.isEditable {
                AnnotationSurface(model: model)
            } else if let image = model.capturedImage {
                // Frozen: the issue already exists — show the capture, no edits.
                VStack(alignment: .leading, spacing: 8) {
                    AnnotationToolbar(model: model)
                        .hidden()
                        .disabled(true)
                    Image(nsImage: image)
                        .resizable()
                        .interpolation(.high)
                        .scaledToFit()
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                }
            }
        } else {
            // The empty slot holds the split's geometry until a capture
            // lands (issue 04 fills it with the placeholder).
            Color.clear
        }
    }

    /// The control column, ordered by use: Capture (once the Build is
    /// running), the session-wide Design Reference, the tray, and the
    /// compose fields for the selected Finding.
    private var controlColumn: some View {
        VStack(alignment: .leading, spacing: 12) {
            if model.isReviewing {
                Button("Capture") {
                    Task { await model.captureScreen() }
                }
                .keyboardShortcut("s", modifiers: [.command])
                .disabled(model.isBusy || model.hasPendingLabelDraft)
            }

            // Session-level Design Reference: one Figma URL for every
            // Finding of this session (a per-Finding override lives in the
            // compose fields). A link, never a rendering (ADR-0003).
            TextField("Design Reference (Figma URL, all Findings)", text: $model.sessionDesignReferenceField)
                .disabled(model.isBusy)

            if model.session?.tray.isEmpty == false {
                traySection
            }

            if model.selectedItem?.isEditable == true {
                composeSection
            }

            Spacer(minLength: 0)
        }
    }

    /// The session tray: every capture in order, selectable for editing,
    /// discardable until filing touches it, carrying its issue link once
    /// filed. File-all lives here — the one end-of-session action.
    @ViewBuilder
    private var traySection: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(model.session?.tray ?? []) { item in
                trayRow(item)
            }
        }
        Button("File all (\(model.remainingFindingCount))") {
            Task { await model.fileAllFindings() }
        }
        .disabled(!model.canFileAll)
    }

    private func trayRow(_ item: TrayItem) -> some View {
        HStack(spacing: 8) {
            let summary = item.finding.summary.trimmingCharacters(in: .whitespacesAndNewlines)
            Text(summary.isEmpty ? "Untitled Finding" : summary)
                .lineLimit(1)
            Text(item.finding.deviceContext.deviceModel)
                .foregroundStyle(.secondary)
            Spacer()
            if let filed = item.filedIssue {
                Link(filed.idReadable, destination: filed.url)
            } else if item.isEditable {
                Button("Discard") { model.discardFinding(id: item.id) }
                    .buttonStyle(.borderless)
                    .disabled(model.isBusy || model.hasPendingLabelDraft)
            } else {
                // Mid-ladder: its issue exists but is incomplete — a File
                // all retry finishes it without re-creating anything.
                Text(model.isBusy ? "Filing…" : "Filing interrupted — retry")
                    .foregroundStyle(.orange)
            }
        }
        .padding(.vertical, 3)
        .padding(.horizontal, 6)
        .contentShape(Rectangle())
        .onTapGesture { model.selectItem(item.id) }
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(model.selectedItemID == item.id ? Color.accentColor.opacity(0.15) : .clear)
        )
    }

    @ViewBuilder
    private var composeSection: some View {
        TextField("Summary", text: $model.summaryField)
            .disabled(model.isBusy)
        TextField("Description", text: $model.descriptionField, axis: .vertical)
            .lineLimit(3...6)
            .disabled(model.isBusy)
        TextField("Design Reference (Figma URL, this Finding only)", text: $model.findingDesignReferenceField)
            .disabled(model.isBusy)
    }

    /// The local history log: filed sessions with their issue links,
    /// newest first — the "did I already file this?" answer. Read-only
    /// rows, read from disk; no YouTrack state is ever fetched for it.
    @ViewBuilder
    private var historySection: some View {
        if !model.history.isEmpty {
            Divider()
            Text("History")
                .font(.headline)
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(model.history) { entry in
                        historyRow(entry)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 180)
        }
    }

    private func historyRow(_ entry: HistoryEntry) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                Text(entry.project.name)
                    .font(.callout.weight(.semibold))
                Text("\(entry.build.bundleID) \(entry.build.version) (\(entry.build.buildNumber))")
                    .font(.callout.monospaced())
                    .foregroundStyle(.secondary)
                Text(entry.startedAt.formatted(date: .abbreviated, time: .shortened))
                    .foregroundStyle(.secondary)
            }
            ForEach(entry.findings, id: \.issue.idReadable) { finding in
                HStack(spacing: 8) {
                    Link(finding.issue.idReadable, destination: finding.issue.url)
                    let summary = finding.summary.trimmingCharacters(in: .whitespacesAndNewlines)
                    Text(summary.isEmpty ? "Untitled Finding" : summary)
                        .lineLimit(1)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}
