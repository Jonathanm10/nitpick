import NitpickCore
import SwiftUI

struct ContentView: View {
    @Bindable var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            youTrackSection
            Divider()
            dropZone
            if model.build != nil {
                deviceRow
            }
            if model.isReviewing {
                captureSection
            }
            if let message = model.errorMessage {
                Text(message)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }
            Spacer(minLength: 0)
        }
        .padding(20)
        .frame(minWidth: 520, minHeight: 640)
        .dropDestination(for: URL.self) { urls, _ in
            guard let url = urls.first else { return false }
            Task { await model.ingest(url) }
            return true
        }
        .task { await model.loadYouTrack() }
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

    private var deviceRow: some View {
        HStack(spacing: 12) {
            Picker("Device", selection: $model.selectedDeviceID) {
                ForEach(model.devices) { device in
                    Text("\(device.name) — \(device.osName)")
                        .tag(Optional(device.id))
                }
            }
            .labelsHidden()

            Button("Start review") {
                Task { await model.startReview() }
            }
            .keyboardShortcut(.defaultAction)
            .disabled(model.selectedDevice == nil || model.isBusy)
        }
    }

    private var captureSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button("Capture") {
                Task { await model.captureScreen() }
            }
            .keyboardShortcut("s", modifiers: [.command])
            .disabled(model.isBusy)

            if let image = model.capturedImage {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFit()
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
    }
}
