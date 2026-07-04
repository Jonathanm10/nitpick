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
    private(set) var isBusy = false
    var errorMessage: String?

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

    func ingest(_ url: URL) async {
        await perform {
            build = try await core.ingestBuild(at: url)
            isReviewing = false
            capturedImage = nil
            devices = try await core.simulatorDevices()
            if selectedDevice == nil {
                selectedDeviceID = devices.first?.id
            }
        }
    }

    func startReview() async {
        guard let build, let device = selectedDevice else { return }
        await perform {
            try await core.launch(build, on: device)
            isReviewing = true
        }
    }

    func captureScreen() async {
        guard let device = selectedDevice else { return }
        await perform {
            let png = try await core.captureScreen(of: device)
            capturedImage = NSImage(data: png)
        }
    }

    private func perform(_ action: () async throws -> Void) async {
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }
        do {
            try await action()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
