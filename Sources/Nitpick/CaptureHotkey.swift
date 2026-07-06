import Carbon.HIToolbox
import Foundation

/// Permission-free global hotkey for the review loop.
///
/// ADR-0006 rejects `NSEvent` global monitors because they would drag in
/// Accessibility/Input Monitoring permission prompts. Carbon Hot Keys keeps
/// the capture loop silent and session-scoped instead.
final class CaptureHotkey: @unchecked Sendable {
    var onPress: (@MainActor @Sendable () -> Void)?

    func setActive(_ active: Bool) {
        guard active != isActive else { return }
        active ? register() : unregister()
    }

    deinit {
        unregister()
    }

    private var isActive = false
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

    private func register() {
        guard !isActive else { return }

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
        guard handlerStatus == noErr else { return }

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
            return
        }

        self.eventHandlerRef = handlerRef
        self.hotKeyRef = hotKeyRef
        isActive = true
    }

    private func unregister() {
        guard isActive || hotKeyRef != nil || eventHandlerRef != nil else { return }

        if let hotKeyRef {
            UnregisterEventHotKey(hotKeyRef)
            self.hotKeyRef = nil
        }
        if let eventHandlerRef {
            RemoveEventHandler(eventHandlerRef)
            self.eventHandlerRef = nil
        }
        isActive = false
    }
}
