import NitpickCore
import SwiftUI

struct ContentView: View {
    @Bindable var model: AppModel
    /// A Build dropped while the open session still holds unfiled
    /// Findings — staged until the designer confirms the destruction the
    /// collapsed drop zone made invisible (issue 05). Nil otherwise: a
    /// clean drop never touches this.
    @State private var pendingBuildDrop: URL?

    /// Opens the Settings window — the connection's home (issue 01);
    /// the hint row is the only way home points at it.
    @Environment(\.openSettings) private var openSettings
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Fresh captures alone earn the Editor's arrival beat. Selection churn
    /// still changes `captureID`, so tray growth is the honest discriminator.
    @State private var editorArrivalCaptureID = UUID()
    @State private var observedTrayCount = 0
    @State private var observedSessionStartedAt: Date?

    var body: some View {
        Group {
            if let session = model.session {
                NavigationStack {
                    sessionScreen(session)
                }
                .navigationTitle(session.build.appBundleURL.deletingPathExtension().lastPathComponent)
                .navigationSubtitle("\(session.build.identity.version) (\(session.build.identity.buildNumber)) · \(session.project.name)")
            } else if let result = model.filingResult {
                FilingResultView(entry: result, onDone: model.dismissFilingResult)
            } else {
                heroHome
            }
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 22)
        .frame(minWidth: 920, minHeight: 640)
        .background(NitpickTheme.window)
        // Esc at the editor scope claims the key only for the pristine
        // mis-capture discard — an installed no-op would still consume the
        // command, and a Finding the designer has invested in (or a mere
        // Annotation selection) must keep standard field behavior here.
        .onExitCommand(perform: model.editorEscapeWouldDiscard ? { model.handleEditorEscape() } : nil)
        // Command-Return is the one keystroke back to the Build; a hidden
        // default-action button keeps the shortcut live no matter which
        // editor field is focused.
        .overlay(alignment: .topLeading) {
            Button {
                _ = model.returnToBuild()
            } label: {
                EmptyView()
            }
            .keyboardShortcut(.return, modifiers: .command)
            .hidden()
            .accessibilityHidden(true)
        }
        // One-shot window growth at Start review (issue 03): fires on the
        // session's closed→open edge — nothing mid-loop reopens a session.
        .background(SessionWindowGrowth(isSessionOpen: model.session != nil))
        .dropDestination(for: URL.self) { urls, _ in
            // A drop is accepted in every state — home, a live session, and
            // the in-place filing result (issue 03): dropping onto the
            // result ingests exactly as home does, dismissing it for the
            // next review. Only a live session's unfiled work stages a
            // confirmation below.
            guard let url = urls.first else { return false }
            // Ingesting ends the open session (one Build per Review
            // Session) — and with it every unfiled Finding. A session
            // holding unfiled work stages the drop behind a confirmation;
            // a clean one ingests without ceremony, exactly as before.
            // The guard is deliberately not pre-validating the URL: a
            // stray non-Build drop over unfiled work confirms and then
            // fails with today's ingest error, session untouched (ingest
            // throws before any teardown) — a spurious dialog is the safe
            // failure; a stale view-side validity check could silently
            // skip the guard for a Build shape ingest later accepts.
            if model.session?.hasUnfiledFindings == true {
                pendingBuildDrop = url
            } else {
                Task { await model.ingest(url) }
            }
            return true
        }
        .confirmationDialog(
            "Ingest the dropped Build?",
            isPresented: Binding(
                get: { pendingBuildDrop != nil },
                set: { if !$0 { pendingBuildDrop = nil } }
            ),
            presenting: pendingBuildDrop
        ) { url in
            Button("Discard and Ingest", role: .destructive) {
                Task { await model.ingest(url) }
            }
            .motionPressFeedback()
            Button("Cancel", role: .cancel) {}
            .motionPressFeedback()
        } message: { _ in
            Text("Ingesting a new Build ends this review — \(unfiledFindingsPhrase) will be discarded.")
        }
        .confirmationDialog(
            "End the review?",
            isPresented: $model.endReviewConfirmationRequested
        ) {
            Button("End Review", role: .destructive) {
                Task { await model.endReview() }
            }
            .motionPressFeedback()
            Button("Cancel", role: .cancel) {}
            .motionPressFeedback()
        } message: {
            Text("Ending this review will discard \(unfiledFindingsPhrase).")
        }
        .task { await model.onLaunch() }
        .overlay(alignment: .topTrailing) {
            if model.isBusy {
                ProgressView()
                    .controlSize(.small)
                    .padding(24)
            }
        }
        .overlay(alignment: .bottom) {
            if let notice = model.droppedFieldNotice {
                DroppedFieldToast(message: notice, onDismiss: model.dismissDroppedFieldNotice)
                    .padding(.bottom, 18)
                    .transition(
                        MotionTokens.reducedMotionAware(
                            .move(edge: .bottom).combined(with: .opacity),
                            reduceMotion: reduceMotion
                        )
                    )
            }
        }
        .animation(reduceMotion ? nil : MotionTokens.enter, value: model.droppedFieldNotice)
    }

    /// The confirmation's count, in the domain's words (PRD story 20):
    /// "3 unfiled Findings", "1 unfiled Finding".
    private var unfiledFindingsPhrase: String {
        let count = model.unfiledFindingCount
        return count == 1 ? "1 unfiled Finding" : "\(count) unfiled Findings"
    }

    /// The no-session hero (issue 04): the drop zone centered as the
    /// workflow's entry point, the session's three inputs grouped beneath
    /// it as one step, and the trace line at the foot. Ingest and launch
    /// errors render under the group — where the action that caused them
    /// lives.
    @ViewBuilder
    private var heroHome: some View {
        Spacer(minLength: 0)
        VStack(alignment: .leading, spacing: 16) {
            dropZone
            startGroup
            if let message = model.errorMessage {
                errorLine(message)
            }
        }
        .frame(maxWidth: 440)
        .frame(maxWidth: .infinity)
        Spacer(minLength: 0)
        if let trace = model.historyTrace {
            HistoryTraceLine(trace: trace)
        }
    }

    /// The one step beneath the drop zone (issue 04): device, project, and
    /// Start review — the three inputs a Review Session consumes. Setup
    /// guidance stands in for the device picker until the Mac is ready
    /// (issue 10); the not-connected hint sits in the project picker's
    /// slot (issue 01).
    @ViewBuilder
    private var startGroup: some View {
        if let guidance = model.setupGuidance {
            setupGuidanceSection(guidance)
        } else {
            DevicePicker(model: model)
        }
        projectSlot
        Button(model.startReviewTitle) {
            Task { await model.startReview() }
        }
        .keyboardShortcut(.defaultAction)
        .disabled(!model.canStartReview)
        .help("Reviewing needs a device and a YouTrack project — the session files into it.")
        .motionPressFeedback()
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    /// Ingest, launch, and filing failures — shown on home, in both
    /// states, where the designer acted.
    private func errorLine(_ message: String) -> some View {
        Text(message)
            .foregroundStyle(.red)
            .textSelection(.enabled)
    }

    /// The project picker's slot (issue 01): the picker itself when a
    /// connection exists — Review Session context, pinned at Start review —
    /// or a hint pointing at Settings when none does, so a disabled Start
    /// review is never unexplained. No connection chrome lives on home;
    /// the form, identity, and errors moved to the Settings window.
    @ViewBuilder
    private var projectSlot: some View {
        if let connection = model.youTrack {
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
            HStack(spacing: 12) {
                Text("Not connected to YouTrack")
                    .foregroundStyle(.secondary)
                Button("Open Settings…") { openSettings() }
                    .motionPressFeedback()
            }
        }
    }

    /// The hero drop zone (issue 04): the workflow's entry point, centered
    /// and unmissable. Empty it invites the drop; loaded it names the Build
    /// under review — name, version, build number (PRD story 25).
    private var dropZone: some View {
        RoundedRectangle(cornerRadius: 16)
            .strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [6]))
            .foregroundStyle(.secondary)
            .frame(height: 200)
            .frame(maxWidth: .infinity)
            .overlay {
                if let build = model.build {
                    VStack(spacing: 6) {
                        Text(build.appBundleURL.deletingPathExtension().lastPathComponent)
                            .font(.title2.weight(.semibold))
                        Text("\(build.identity.bundleID) \(build.identity.version) (\(build.identity.buildNumber))")
                            .font(.callout.monospaced())
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                } else {
                    VStack(spacing: 10) {
                        Image(systemName: "square.and.arrow.down.on.square")
                            .font(.system(size: 36, weight: .light))
                            .foregroundStyle(.tertiary)
                        Text("Drop a simulator Build (.app or .zip)")
                            .font(.title3)
                            .foregroundStyle(.secondary)
                    }
                }
            }
    }

    private func sessionScreen(_ session: ReviewSession) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let guidance = model.setupGuidance {
                setupGuidanceSection(guidance)
            } else {
                sessionHeader(session)
            }
            sessionSplit(session)
            if let message = model.errorMessage {
                errorLine(message)
            }
        }
    }

    private func sessionHeader(_ session: ReviewSession) -> some View {
        HStack(spacing: 12) {
            DeviceContextChip(model: model)
            Divider()
                .frame(height: 22)
            Text("\(session.build.identity.version) (\(session.build.identity.buildNumber)) · \(session.project.name)")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(NitpickTheme.secondaryText)
                .lineLimit(1)
                .layoutPriority(1)
            statusPill
            // A restored session's one next step must stay in sight — a primary
            // action never hides behind the popover.
            Spacer(minLength: 8)
            if !model.isReviewing {
                Button(model.startReviewTitle) {
                    Task { await model.startReview() }
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(!model.canStartReview)
                .help("Reviewing needs a device and a YouTrack project — the session files into it.")
                .motionPressFeedback()
            } else {
                HStack(spacing: 8) {
                    KeyCapHint("⌘S")
                    Button {
                        Task { await model.captureScreen() }
                    } label: {
                        Label("Capture", systemImage: "camera")
                    }
                    .buttonStyle(.bordered)
                    .disabled(!model.canCapture)
                    .motionPressFeedback()
                }
            }
        }
        .frame(minHeight: 44, alignment: .center)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(NitpickTheme.border)
                .frame(height: 1)
        }
    }

    private var statusPill: some View {
        Label(model.isReviewing ? "Review in progress" : "Ready to resume", systemImage: "circle.fill")
            .font(.system(size: 13, weight: .medium))
            .labelStyle(.titleAndIcon)
            .foregroundStyle(Color.accentColor)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(Color.accentColor.opacity(0.10), in: Capsule())
            .lineLimit(1)
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
                .motionPressFeedback()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(4)
        }
    }

    /// The open session, split (issue 01): the capture pane takes the
    /// remaining width, while the inspector keeps adaptive min/ideal/max
    /// bounds so the workspace can resize without a hard fixed column.
    private func sessionSplit(_ session: ReviewSession) -> some View {
        HStack(alignment: .top, spacing: 0) {
            capturePane
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .layoutPriority(1)
            controlColumn(session)
                .frame(
                    minWidth: NitpickTheme.inspectorMinWidth,
                    idealWidth: NitpickTheme.inspectorIdealWidth,
                    maxWidth: NitpickTheme.inspectorMaxWidth,
                    alignment: .topLeading
                )
                .padding(.leading, 24)
                .overlay(alignment: .leading) {
                    Rectangle()
                        .fill(NitpickTheme.border)
                        .frame(width: 1)
                }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .onAppear { syncEditorArrivalState(for: session) }
        .onChange(of: session.startedAt) { syncEditorArrivalState(for: session) }
        .onChange(of: session.tray.count) { registerEditorArrivalIfNeeded(for: session) }
    }

    /// The full-size pane: the selected Finding under edit, or — once
    /// filed — the same capture frozen at the same size, no edits. The
    /// hidden toolbar keeps the editable layout's slot, so selecting
    /// between editable and frozen rows never resizes the image.
    @ViewBuilder
    private var capturePane: some View {
        if let item = model.selectedItem {
            capturePaneContent(for: item)
                .id(editorArrivalCaptureID)
                .transition(captureArrivalTransition)
        } else {
            capturePlaceholder
        }
    }

    @ViewBuilder
    private func capturePaneContent(for item: TrayItem) -> some View {
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
                    .shadow(color: .black.opacity(0.08), radius: 18, x: 0, y: 8)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
    }

    // PRD stories 5, 6, and 19: a fresh capture alone earns the arrival beat.
    // The tray count is the discriminator because `captureID` also changes when
    // a row is merely selected, but only a new Finding grows the tray.
    private var captureArrivalTransition: AnyTransition {
        MotionTokens.reducedMotionAware(
            .offset(x: 0, y: -10)
                .combined(with: .scale(scale: 0.985, anchor: .topLeading))
                .combined(with: .opacity),
            reduceMotion: reduceMotion
        )
    }

    private func syncEditorArrivalState(for session: ReviewSession) {
        observedSessionStartedAt = session.startedAt
        observedTrayCount = session.tray.count
        editorArrivalCaptureID = model.captureID
    }

    private func registerEditorArrivalIfNeeded(for session: ReviewSession) {
        if observedSessionStartedAt != session.startedAt {
            syncEditorArrivalState(for: session)
            return
        }
        let trayCount = session.tray.count
        defer { observedTrayCount = trayCount }
        guard trayCount > observedTrayCount else { return }
        // With successive captures, keep retargeting the same arrival lane
        // instead of queueing transitions; selection changes never reach here.
        withAnimation(MotionTokens.arrive) {
            editorArrivalCaptureID = model.captureID
        }
    }

    /// A portrait phone outline (9:19.5 — every current iPhone). The pane
    /// is device-aspect, not device-exact: the selected simulator device
    /// carries no point-size metadata, and the PRD (Q5) rejects a lookup
    /// table for marginal gain.
    private static let placeholderDeviceAspect = CGSize(width: 9, height: 19.5)

    /// The empty pane (issue 04): between Start review and the first
    /// capture — and whenever a discard clears the selection — a subdued
    /// device-aspect outline holds the capture's slot with the next step
    /// spelled out. Same skeleton as the editable pane (hidden toolbar
    /// above an aspect-fitted rectangle), so the first ⌘S replaces it in
    /// place and a mid-session discard never collapses the pane.
    private var capturePlaceholder: some View {
        VStack(alignment: .leading, spacing: 8) {
            AnnotationToolbar(model: model)
                .hidden()
                .disabled(true)
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [6]))
                .foregroundStyle(NitpickTheme.strongBorder)
                .background(NitpickTheme.inset, in: RoundedRectangle(cornerRadius: 8))
                .aspectRatio(Self.placeholderDeviceAspect, contentMode: .fit)
                .overlay {
                    Text("⌘S to capture")
                        .font(.title3)
                        .foregroundStyle(NitpickTheme.secondaryText)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    /// The control column, ordered by use: Capture (once the Build is
    /// running), the session-wide Design Reference, the tray, the compose
    /// fields for the selected Finding, and End Review at the foot.
    private func controlColumn(_ session: ReviewSession) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            // Session-level Design Reference: one Figma URL for every
            // Finding of this session (a per-Finding override lives in the
            // compose fields). A link, never a rendering (ADR-0003).
            HStack(spacing: 8) {
                Image(systemName: "link")
                    .foregroundStyle(NitpickTheme.secondaryText)
                TextField("Design Reference (Figma URL, all Findings)", text: $model.sessionDesignReferenceField)
                    .textFieldStyle(.plain)
            }
                .nitpickField(minHeight: 32)
                .disabled(model.isBusy)

            if session.tray.isEmpty == false {
                traySection(session.tray)
            }

            if model.selectedItem?.isEditable == true {
                composeSection
            }

            // Only the tray scrolls (never the whole column). Design ref,
            // compose, and End Review are rigid and keep default layout
            // priority; the tray's List is the column's sole flexible
            // absorber — it carries a flexible frame and a lower priority,
            // so it, not this Spacer, yields first when space is tight.
            // The Spacer sits lower still: it soaks only the slack left once
            // the tray sits at its natural cap, pinning End Review at the
            // foot with room to spare. As the column tightens the Spacer
            // closes, then the tray shrinks and scrolls; compose never moves.
            Spacer(minLength: 0)
                .layoutPriority(-2)

            Button("End Review") {
                model.requestEndReview()
            }
            .buttonStyle(.borderless)
            .foregroundStyle(.secondary)
            .disabled(!model.canEndReview)
            .motionPressFeedback()
        }
        // Full height so the Spacer can pin End Review at the column's foot;
        // the tray flexes between its cap and a ~2-row floor within it.
        .frame(maxHeight: .infinity, alignment: .topLeading)
    }

    /// The session tray: the rows live in a platform List so swipe actions get
    /// native physics and full-swipe behavior, while File all stays as the
    /// explicit end-of-section action beneath them.
    @ViewBuilder
    private func traySection(_ tray: [TrayItem]) -> some View {
        HStack {
            Text("Tray")
                .nitpickSectionLabel()
            Spacer()
            Text("\(model.unfiledFindingCount) unfiled")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(NitpickTheme.secondaryText)
        }
        // The one flexible child of the column: a lower priority than the
        // rigid compose fields so it yields space first, but higher than the
        // foot Spacer so it reaches its cap before the Spacer opens (see
        // controlColumn). It shrinks and scrolls internally under pressure.
        TrayView(tray: tray, model: model)
            .layoutPriority(-1)
        if let phase = model.filingPhase {
            Button {
                Task { await model.fileAllFindings() }
            } label: {
                filingButtonLabel(phase)
            }
            .disabled(!model.canFileAll)
            .tint(isAllFiled(phase) ? .green : .accentColor)
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .animation(reduceMotion ? nil : MotionTokens.enter, value: phase)
            .motionPressFeedback()
        }
    }
    private func filingButtonLabel(_ phase: FilingPhase) -> some View {
        HStack(spacing: 6) {
            if isFiling(phase) {
                ProgressView()
                    .controlSize(.small)
            }
            filingCheckmark(isAllFiled: isAllFiled(phase))
            Text(filingButtonText(for: phase))
                .contentTransition(.opacity)
        }
        .font(.callout)
        .foregroundStyle(.white)
        .lineLimit(1)
        .frame(maxWidth: .infinity, minHeight: 32)
    }

    private func filingButtonText(for phase: FilingPhase) -> String {
        switch phase {
        case .idle(let unfiled):
            return "File all (\(unfiled))"
        case .filing(let completed, let of):
            return "Filing \(completed) of \(of)…"
        case .remaining(let unfiled):
            return "File \(unfiled) remaining"
        case .allFiled(let count):
            return "Filed \(count)"
        }
    }

    private func isAllFiled(_ phase: FilingPhase) -> Bool {
        if case .allFiled = phase { return true }
        return false
    }

    private func isFiling(_ phase: FilingPhase) -> Bool {
        if case .filing = phase { return true }
        return false
    }

    @ViewBuilder
    private func filingCheckmark(isAllFiled: Bool) -> some View {
        ZStack {
            if isAllFiled {
                Image(systemName: "checkmark")
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(.green)
                    .transition(
                        MotionTokens.reducedMotionAware(
                            .scale.combined(with: .opacity),
                            reduceMotion: reduceMotion
                        )
                    )
            }
        }
        .frame(width: isAllFiled ? 14 : 0)
        .animation(MotionTokens.pop, value: isAllFiled)
    }

    @ViewBuilder
    private var composeSection: some View {
        // Type first: always set, always shown (glossary: Type). A fresh
        // capture is a Bug until the designer flips it — no stickiness.
        Text("Type")
            .nitpickSectionLabel()
        Picker("Type", selection: $model.typeField) {
            ForEach(FindingType.allCases, id: \.self) { type in
                Text(type.label).tag(type)
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .disabled(model.isBusy)
        .motionPressFeedback()
        // Priority: shown only when the project's schema offered a scale
        // (hidden otherwise — never offer a choice that can't be filed).
        // None is a first-class choice: the Issue takes the project default.
        if !model.sessionSchema.priorities.isEmpty {
            Text("Priority")
                .nitpickSectionLabel()
            Picker("Priority", selection: $model.priorityField) {
                Text("No priority").tag(FindingPriority?.none)
                ForEach(model.sessionSchema.priorities, id: \.self) { priority in
                    Text(priority.name).tag(FindingPriority?.some(priority))
                }
            }
            .labelsHidden()
            .disabled(model.isBusy)
        }
        // Assignee: shown only when the project has assignable users. A
        // searchable people-picker; unassigned is a first-class choice.
        if !model.sessionSchema.assignees.isEmpty {
            Text("Assignee")
                .nitpickSectionLabel()
            AssigneePicker(
                assignees: model.sessionSchema.assignees,
                selection: $model.assigneeField,
                disabled: model.isBusy
            )
        }
        Text("Summary *")
            .nitpickSectionLabel()
        TextField("Summary", text: $model.summaryField)
            .onSubmit { _ = model.returnToBuild() }
            .nitpickField(minHeight: 34)
            .disabled(model.isBusy)
        Text("Description")
            .nitpickSectionLabel()
        TextField("Description", text: $model.descriptionField, axis: .vertical)
            .lineLimit(3...6)
            .nitpickField(minHeight: 116)
            .disabled(model.isBusy)
        Text("Design Reference")
            .nitpickSectionLabel()
        TextField("Design Reference (Figma URL, this Finding only)", text: $model.findingDesignReferenceField)
            .nitpickField(minHeight: 34)
            .disabled(model.isBusy)
    }
}


/// A keyboard-shortcut hint next to a control (design system `KeyCap`):
/// mono glyphs in a hairline key outline, radius 3 per the chips/keys token.
private struct KeyCapHint: View {
    let key: String

    init(_ key: String) {
        self.key = key
    }

    var body: some View {
        Text(key)
            .font(.caption.monospaced())
            .foregroundStyle(NitpickTheme.secondaryText)
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(
                RoundedRectangle(cornerRadius: 3)
                    .fill(.white)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 3)
                    .strokeBorder(NitpickTheme.strongBorder, lineWidth: 1)
            }
            .accessibilityHidden(true)
    }
}
