import AppKit
import Carbon.HIToolbox
import NitpickCore

/// Permission-free global hotkey for the review loop.
///
/// ADR-0006 rejects `NSEvent` global monitors because they would drag in
/// Accessibility/Input Monitoring permission prompts. Carbon Hot Keys keeps
/// the capture loop silent and session-scoped instead.
final class CaptureHotkey: @unchecked Sendable {
    var onPress: (@MainActor @Sendable () -> Void)?
    /// Called only when `state` changes, never from `deinit`.
    var onStateChange: (@MainActor (CaptureHotkeyState) -> Void)?
    private(set) var state: CaptureHotkeyState = .inactive

    /// A taken chord stays taken until deactivated, so repeat calls never
    /// re-run the Carbon registration. Coming back to nitpick retries it,
    /// since the other app may have let it go meanwhile.
    @MainActor
    func setActive(_ active: Bool) {
        if active {
            guard state == .inactive else { return }
            update(register())
        } else {
            unregister()
            update(.inactive)
        }
    }

    init() {
        activationObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.state == .taken else { return }
                self.update(self.register())
            }
        }
    }

    deinit {
        if let activationObserver {
            NotificationCenter.default.removeObserver(activationObserver)
        }
        unregister()
    }

    private var activationObserver: NSObjectProtocol?

    private var hotKeyRef: EventHotKeyRef?
    private var eventHandlerRef: EventHandlerRef?

    private static let hotKeySignature: UInt32 = 0x4E495450 // NITP
    private static let hotKeyID = EventHotKeyID(signature: hotKeySignature, id: 1)
    private static let hotKeyKeyCode = UInt32(kVK_ANSI_N)
    private static let hotKeyModifiers = UInt32(cmdKey | optionKey | controlKey)
    private static let eventTypes = [
        EventTypeSpec(eventClass: UInt32(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    ]

    private static let eventHandler: EventHandlerUPP = { _, _, userData in
        guard let userData else { return noErr }
        let hotKey = Unmanaged<CaptureHotkey>.fromOpaque(userData).takeUnretainedValue()
        let onPress = hotKey.onPress
        Task { @MainActor in
            onPress?()
        }
        return noErr
    }

    @MainActor
    private func update(_ next: CaptureHotkeyState) {
        guard next != state else { return }
        state = next
        onStateChange?(next)
    }

    private func register() -> CaptureHotkeyState {
        var handlerRef: EventHandlerRef?
        let handlerStatus = Self.eventTypes.withUnsafeBufferPointer { types in
            InstallEventHandler(
                GetEventDispatcherTarget(),
                Self.eventHandler,
                types.count,
                types.baseAddress,
                Unmanaged.passUnretained(self).toOpaque(),
                &handlerRef
            )
        }
        guard handlerStatus == noErr else { return .taken }

        var hotKeyRef: EventHotKeyRef?
        let hotKeyStatus = RegisterEventHotKey(
            Self.hotKeyKeyCode,
            Self.hotKeyModifiers,
            Self.hotKeyID,
            GetEventDispatcherTarget(),
            0,
            &hotKeyRef
        )
        guard hotKeyStatus == noErr else {
            if let handlerRef {
                RemoveEventHandler(handlerRef)
            }
            return .taken
        }

        self.eventHandlerRef = handlerRef
        self.hotKeyRef = hotKeyRef
        return .registered
    }

    private func unregister() {
        if let hotKeyRef {
            UnregisterEventHotKey(hotKeyRef)
            self.hotKeyRef = nil
        }
        if let eventHandlerRef {
            RemoveEventHandler(eventHandlerRef)
            self.eventHandlerRef = nil
        }
    }
}
