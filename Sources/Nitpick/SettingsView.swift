import NitpickCore
import SwiftUI

/// The Settings window (⌘,): the YouTrack connection's one native home
/// (issue 01). Owns both connection states — the connect form when
/// unconnected, the verified identity with a change-connection action once
/// connected — and shows connection errors next to the form that caused
/// them. Relocation, not redesign: every connection semantic (session
/// survival on reconnect, token cleared after connect, saved connection
/// restored at launch) lives in the model, unchanged.
struct SettingsView: View {
    @Bindable var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let connection = model.youTrack {
                Text("YouTrack")
                    .font(.headline)
                HStack(spacing: 12) {
                    Text("Connected as \(connection.user.fullName) (\(connection.user.login))")
                    Spacer()
                    Button("Change…") { model.editYouTrackConnection() }
                }
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
        .padding(20)
        .frame(width: 460, alignment: .leading)
    }
}
