import Foundation

/// Exists only after a successful launch, so a failed or in-flight switch
/// can never stamp a Finding with a device the Build isn't running on.
public struct ReviewRun: Equatable, Sendable {
    public let device: SimulatorDevice
    public let host: SimulatorHostApp

    public init(device: SimulatorDevice, host: SimulatorHostApp) {
        self.device = device
        self.host = host
    }
}

/// Exists only when a start is allowed. The Build is part of the decision
/// because the hero shows the Start button before a Build exists.
public struct ReviewStart: Equatable, Sendable {
    public let build: Build
    /// The restored session's pinned project, else the picker's choice:
    /// filing never re-asks.
    public let project: YouTrackProject

    public init?(
        build: Build?,
        run: ReviewRun?,
        filingResult: HistoryEntry?,
        device: SimulatorDevice?,
        session: ReviewSession?,
        selectedProject: YouTrackProject?,
        activity: ShellActivity
    ) {
        guard let build,
              run == nil,
              filingResult == nil,
              device?.isRuntimeAvailable == true,
              let project = session?.project ?? selectedProject,
              !activity.isBusy
        else { return nil }
        self.build = build
        self.project = project
    }
}
