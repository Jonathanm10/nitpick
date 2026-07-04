import Foundation
import NitpickCore
import Testing

/// Drives the real flow against live simctl. Gated behind NITPICK_LIVE_SMOKE
/// because it boots a simulator and takes minutes on a cold machine.
/// Run via `scripts/live-smoke/run.sh`, which builds the smoke Build and
/// sets NITPICK_SMOKE_ZIP.
@Suite(.enabled(if: ProcessInfo.processInfo.environment["NITPICK_LIVE_SMOKE"] == "1"))
struct LiveSmokeTests {
    @Test("real ingest → boot → install → launch → capture yields a native-resolution PNG")
    func realWholeFlow() async throws {
        let zipPath = try #require(ProcessInfo.processInfo.environment["NITPICK_SMOKE_ZIP"])
        let workspace = try Fixtures.makeTemporaryDirectory()
        let core = AppCore(environment: .live(), workspaceDirectory: workspace)

        let build = try await core.ingestBuild(at: URL(fileURLWithPath: zipPath))
        #expect(build.identity.bundleID == "ch.liip.nitpick.smoke")
        #expect(build.identity.version == "1.0.0")
        #expect(build.identity.buildNumber == "7")

        let devices = try await core.simulatorDevices().filter(\.isRuntimeAvailable)
        try #require(!devices.isEmpty)
        // Prefer an already-booted device to keep the smoke fast.
        let device = devices.first { $0.isBooted } ?? devices[0]

        // Leave the machine as found: uninstall the smoke app, and shut the
        // device down again if this test booted it.
        func cleanUp() async {
            let runner = ProcessSubprocessRunner()
            let xcrun = "/usr/bin/xcrun"
            _ = try? await runner.run(SubprocessCommand(
                executablePath: xcrun,
                arguments: ["simctl", "uninstall", device.udid, build.identity.bundleID]
            ))
            if !device.isBooted {
                _ = try? await runner.run(SubprocessCommand(
                    executablePath: xcrun, arguments: ["simctl", "shutdown", device.udid]
                ))
            }
        }

        do {
            try await core.launch(build, on: device)
            // Give the freshly launched app a beat to draw.
            try await Task.sleep(for: .seconds(3))

            let png = try await core.captureScreen(of: device)
            let pngSignature = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
            #expect(png.prefix(8) == pngSignature)

            // IHDR width/height, big-endian at offsets 16 and 20: native device
            // pixels are well past any window-sized capture.
            let width = png.subdata(in: 16..<20).reduce(0) { $0 << 8 | UInt32($1) }
            let height = png.subdata(in: 20..<24).reduce(0) { $0 << 8 | UInt32($1) }
            #expect(width >= 1000)
            #expect(height >= 1000)
            print("live smoke: \(device.name) (\(device.osName)) captured \(width)x\(height) PNG, \(png.count) bytes")
        } catch {
            await cleanUp()
            throw error
        }
        await cleanUp()
    }
}
