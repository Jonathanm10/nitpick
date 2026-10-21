import Foundation

/// The Build running in a simulator: the device it launched on and the host
/// app it runs in. It exists only after a successful launch, so a failed or
/// in-flight switch can never stamp a Finding with a device the Build isn't
/// running on.
public struct ReviewRun: Equatable, Sendable {
    public let device: SimulatorDevice
    public let host: SimulatorHostApp

    public init(device: SimulatorDevice, host: SimulatorHostApp) {
        self.device = device
        self.host = host
    }
}
