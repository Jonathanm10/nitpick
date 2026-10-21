import AppKit
import Foundation
import NitpickCore
import SwiftUI

// Dev-only NITPICK_SNAPSHOT_* seams. Prints here are the proof package's measurements.
// Like the other seams they are not behind `#if DEBUG`; none of them calls send or file itself.

@MainActor
enum WindowSnapshot {
    /// `NITPICK_SNAPSHOT_SIZE=WxH` renders an offscreen, never-key copy of the
    /// main view at exactly that size instead of the real window: layout QA
    /// no longer depends on the window manager (a tiler can pin the real
    /// frame), and the inactive-window look the designer sees while working
    /// in the Simulator is deterministic.
    static let requestedSize: NSSize? = {
        guard let value = ProcessInfo.processInfo.environment["NITPICK_SNAPSHOT_SIZE"] else { return nil }
        let parts = value.split(separator: "x").compactMap { Double($0) }
        guard parts.count == 2 else { return nil }
        return NSSize(width: parts[0], height: parts[1])
    }()

    private static var offscreenWindow: NSWindow?

    /// Hosts a second `ContentView` over the same model in a borderless
    /// window parked off every screen. Called once, after launch restored
    /// the session, so the copy renders the same state as the real window.
    static func stageOffscreenCopy(model: AppModel) {
        guard offscreenWindow == nil, let size = requestedSize else { return }
        let window = NSWindow(
            contentRect: NSRect(origin: CGPoint(x: -10_000, y: 0), size: size),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.contentView = NSHostingView(rootView: ContentView(model: model, isSnapshotCopy: true))
        window.orderFront(nil)
        offscreenWindow = window
    }

    static func scheduleIfRequested() {
        let environment = ProcessInfo.processInfo.environment
        if let path = environment["NITPICK_SNAPSHOT_AX"] {
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) {
                AccessibilityDump.write(to: path)
            }
        }
        if let path = environment["NITPICK_SNAPSHOT_MENU"] {
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) {
                guard let menu = NSApp.mainMenu else { return }
                NSApp.mainMenu?.update()
                var lines: [String] = []
                MenuDump.append(menu, depth: 0, to: &lines)
                try? lines.joined(separator: "\n").appending("\n")
                    .write(toFile: path, atomically: true, encoding: .utf8)
            }
        }
        guard let path = environment["NITPICK_SNAPSHOT_PATH"] else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
            if let window = offscreenWindow, let size = requestedSize {
                // Start-review growth resizes the copy too; pin it back first.
                window.setFrame(NSRect(origin: window.frame.origin, size: size), display: true)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                    guard let view = window.contentView,
                          let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds)
                    else { return }
                    view.cacheDisplay(in: view.bounds, to: rep)
                    try? rep.representation(using: .png, properties: [:])?
                        .write(to: URL(fileURLWithPath: path))
                }
                return
            }
            guard let window = NSApp.nitpickMainWindow
                ?? NSApp.windows.filter({ !$0.isSheet }).max(by: { $0.frame.width < $1.frame.width }),
                  let rep = snapshot(of: window)
            else { return }
            try? rep.representation(using: .png, properties: [:])?
                .write(to: URL(fileURLWithPath: path))
        }
    }

    /// Attached sheets are separate windows `cacheDisplay` omits, so each is
    /// composited at its on-screen offset.
    private static func snapshot(of window: NSWindow) -> NSBitmapImageRep? {
        guard let frame = window.contentView?.superview,
              let rep = frame.bitmapImageRepForCachingDisplay(in: frame.bounds)
        else { return nil }
        frame.cacheDisplay(in: frame.bounds, to: rep)
        var sheet = window.attachedSheet
        guard sheet != nil, let context = NSGraphicsContext(bitmapImageRep: rep) else { return rep }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        while let current = sheet {
            if let sheetView = current.contentView?.superview,
               let sheetRep = sheetView.bitmapImageRepForCachingDisplay(in: sheetView.bounds) {
                sheetView.cacheDisplay(in: sheetView.bounds, to: sheetRep)
                let origin = CGPoint(
                    x: current.frame.minX - window.frame.minX,
                    y: current.frame.minY - window.frame.minY
                )
                sheetRep.draw(in: CGRect(origin: origin, size: current.frame.size))
                print("snapshot: sheet \(current.frame.width)×\(current.frame.height) pt at \(origin)")
                fflush(stdout)
            }
            sheet = current.attachedSheet
        }
        NSGraphicsContext.restoreGraphicsState()
        return rep
    }

    private static var occupiedCaptureHotkey: CaptureHotkey?

    /// `NITPICK_SNAPSHOT_HOTKEY_TAKEN=1` registers the capture chord before the
    /// session opens, so the session's own registration meets a taken chord
    /// the way it would when another app holds it.
    static func occupyCaptureHotkeyIfRequested() {
        guard ProcessInfo.processInfo.environment["NITPICK_SNAPSHOT_HOTKEY_TAKEN"] != nil else { return }
        let squatter = CaptureHotkey()
        squatter.setActive(true)
        occupiedCaptureHotkey = squatter
    }
}

/// `NITPICK_SNAPSHOT_AX=<file>` writes the app's accessibility tree as an
/// assistive client such as VoiceOver reads it: role, label, value, selected.
/// SwiftUI publishes its own elements only to AX clients, not to in-process
/// `accessibilityChildren()`, so this queries the app's own pid through the AX
/// API. Querying itself needs no Accessibility permission. It runs off the
/// main thread, because the main thread is the one that answers.
private enum AccessibilityDump {
    @MainActor
    static func write(to path: String) {
        let pid = getpid()
        Thread.detachNewThread {
            var lines: [String] = []
            let app = AXUIElementCreateApplication(pid)
            for window in elements(app, kAXWindowsAttribute) {
                append(window, depth: 0, to: &lines)
            }
            try? lines.joined(separator: "\n").appending("\n")
                .write(toFile: path, atomically: true, encoding: .utf8)
        }
    }

    private static func append(_ element: AXUIElement, depth: Int, to lines: inout [String]) {
        guard depth < 60 else { return }
        var fields = [string(element, kAXRoleAttribute) ?? "?"]
        if let subrole = string(element, kAXSubroleAttribute) { fields.append("subrole=\(subrole)") }
        for (name, attribute) in [("label", kAXDescriptionAttribute), ("title", kAXTitleAttribute), ("value", kAXValueAttribute), ("help", kAXHelpAttribute)] {
            if let text = string(element, attribute), !text.isEmpty {
                fields.append("\(name)=\"\(text.replacingOccurrences(of: "\n", with: "\\n"))\"")
            }
        }
        if bool(element, kAXSelectedAttribute) == true { fields.append("selected") }
        if bool(element, kAXEnabledAttribute) == false { fields.append("disabled") }
        lines.append(String(repeating: "  ", count: depth) + fields.joined(separator: " "))
        for child in elements(element, kAXChildrenAttribute) {
            append(child, depth: depth + 1, to: &lines)
        }
    }

    private static func value(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
        return value
    }

    private static func string(_ element: AXUIElement, _ attribute: String) -> String? {
        switch value(element, attribute) {
        case let text as String: text
        case let number as NSNumber: number.stringValue
        default: nil
        }
    }

    private static func bool(_ element: AXUIElement, _ attribute: String) -> Bool? {
        (value(element, attribute) as? NSNumber)?.boolValue
    }

    private static func elements(_ element: AXUIElement, _ attribute: String) -> [AXUIElement] {
        (value(element, attribute) as? [AnyObject] ?? []).map { $0 as! AXUIElement }
    }
}

@MainActor
private enum MenuDump {
    static func append(_ menu: NSMenu, depth: Int, to lines: inout [String]) {
        for item in menu.items where !item.isSeparatorItem {
            var line = String(repeating: "  ", count: depth) + item.title
            let chord = chord(of: item)
            if !chord.isEmpty { line += "\t" + chord }
            if !item.isEnabled { line += "\t(disabled)" }
            lines.append(line)
            if let submenu = item.submenu, depth < 1 {
                append(submenu, depth: depth + 1, to: &lines)
            }
        }
    }

    private static func chord(of item: NSMenuItem) -> String {
        guard !item.keyEquivalent.isEmpty else { return "" }
        let flags = item.keyEquivalentModifierMask
        var chord = ""
        if flags.contains(.control) { chord += "⌃" }
        if flags.contains(.option) { chord += "⌥" }
        if flags.contains(.shift) { chord += "⇧" }
        if flags.contains(.command) { chord += "⌘" }
        let key: String = switch item.keyEquivalent.unicodeScalars.first.map({ Int($0.value) }) {
        case NSUpArrowFunctionKey: "↑"
        case NSDownArrowFunctionKey: "↓"
        case NSLeftArrowFunctionKey: "←"
        case NSRightArrowFunctionKey: "→"
        case 13: "↩"
        default: item.keyEquivalent.uppercased()
        }
        return chord + key
    }
}

/// `NITPICK_SNAPSHOT_KEYS` drives the real main window with in-process key
/// events, which need no Accessibility permission, and prints the state after
/// each step. Steps are `;`-separated: `wait:<seconds>`, `mark` (adds an
/// undoable rectangle to the selected Finding), `focus:<placeholder>` (a text
/// field), `type:<text>`, and `key:<chord>` such as `cmd+z` or `opt+cmd+down`.
extension AppModel {
    func runKeyScript(_ script: String) async {
        try? await Task.sleep(for: .seconds(1.5))
        guard let window = NSApp.nitpickMainWindow else {
            print("keys: no main window")
            fflush(stdout)
            return
        }
        logKeyState("start", window: window)
        for step in script.split(separator: ";").map(String.init) {
            let parts = step.split(separator: ":", maxSplits: 1).map(String.init)
            let verb = parts.first ?? ""
            let argument = parts.count > 1 ? parts[1] : ""
            switch verb {
            case "wait":
                try? await Task.sleep(for: .seconds(Double(argument) ?? 0.5))
            case "focus":
                if let field = window.contentView.flatMap({ Self.textField(placeholder: argument, in: $0) }) {
                    window.makeFirstResponder(field)
                }
            case "mark":
                addAnnotation(.rectangle(CGRect(x: 100, y: 900, width: 400, height: 200)))
            case "type":
                for character in argument {
                    Self.send(characters: String(character), keyCode: 0, flags: [], to: window)
                }
            case "key":
                // Key equivalents reach only the key window, and other apps
                // launched meanwhile can take focus between steps.
                for _ in 0..<10 where !window.isKeyWindow {
                    NSApp.activate(ignoringOtherApps: true)
                    window.makeKeyAndOrderFront(nil)
                    try? await Task.sleep(for: .seconds(0.3))
                }
                guard window.isKeyWindow else {
                    print("keys: \(step) skipped, the main window never became key")
                    continue
                }
                Self.sendChord(argument, to: window)
            default:
                print("keys: unknown step \(step)")
            }
            try? await Task.sleep(for: .seconds(0.4))
            logKeyState(step, window: window)
        }
    }

    private func logKeyState(_ step: String, window: NSWindow) {
        let summary = selectedItem.map { "\"\($0.finding.summary)\"" } ?? "none"
        let annotations = selectedItem.map { String($0.finding.annotations.count) } ?? "-"
        let editor = window.firstResponder as? NSTextView
        let field = editor.map { "\"\($0.string)\"" } ?? "none"
        print("keys: \(step) -> selected=\(summary) annotations=\(annotations) focusedText=\(field) active=\(NSApp.isActive) key=\(window.isKeyWindow)")
        fflush(stdout)
    }

    private static func textField(placeholder: String, in view: NSView) -> NSTextField? {
        if let field = view as? NSTextField, field.placeholderString == placeholder { return field }
        for subview in view.subviews {
            if let match = textField(placeholder: placeholder, in: subview) { return match }
        }
        return nil
    }

    /// Built from a virtual key code, so the keyboard layout fills in the
    /// characters exactly as for a hardware press (⇧⌘Z arrives as "Z").
    private static func sendChord(_ chord: String, to window: NSWindow) {
        var flags: CGEventFlags = []
        var key = ""
        for part in chord.split(separator: "+").map(String.init) {
            switch part {
            case "cmd": flags.insert(.maskCommand)
            case "opt": flags.insert(.maskAlternate)
            case "ctrl": flags.insert(.maskControl)
            case "shift": flags.insert(.maskShift)
            default: key = part
            }
        }
        let arrows: [String: CGKeyCode] = ["up": 126, "down": 125, "left": 123, "right": 124]
        guard let keyCode = arrows[key] ?? layoutKeyCode(for: key),
              let cgEvent = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true)
        else {
            print("keys: no key code for \(chord)")
            return
        }
        if keyCode >= 123 { flags.formUnion([.maskSecondaryFn, .maskNumericPad]) }
        cgEvent.flags = flags
        guard let event = NSEvent(cgEvent: cgEvent) else { return }
        print("keys: sending \(chord) characters=\(event.characters ?? "") ignoringModifiers=\(event.charactersIgnoringModifiers ?? "")")
        NSApp.postEvent(event, atStart: false)
    }

    /// The current layout's key for a character: Z sits on a different key
    /// on QWERTZ than on QWERTY.
    private static func layoutKeyCode(for character: String) -> CGKeyCode? {
        (0..<CGKeyCode(51)).first { code in
            CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)
                .flatMap(NSEvent.init(cgEvent:))?.charactersIgnoringModifiers == character
        }
    }

    private static func send(characters: String, keyCode: UInt16, flags: NSEvent.ModifierFlags, to window: NSWindow) {
        guard let event = NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: flags,
            timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: window.windowNumber,
            context: nil,
            characters: characters,
            charactersIgnoringModifiers: characters,
            isARepeat: false,
            keyCode: keyCode
        ) else { return }
        NSApp.postEvent(event, atStart: false)
    }
}
extension AppModel {
    /// A staged `NITPICK_SNAPSHOT_FEEDBACK` state other than "not-connected"
    /// shows the form without a saved connection; the seam never calls send.
    var isFeedbackConnected: Bool {
        if let state = ProcessInfo.processInfo.environment["NITPICK_SNAPSHOT_FEEDBACK"] {
            return state != "not-connected"
        }
        return youTrack != nil
    }

    func stageFeedbackSnapshot(_ state: String) async {
        await presentFeedback()
        guard let feedback else { return }
        guard state != "not-connected" else {
            print("feedback snapshot: state=\(state) connected=\(isFeedbackConnected)")
            fflush(stdout)
            return
        }
        if state != "editing-empty" {
            feedback.title = "Capture button stays disabled after ⌘S"
            feedback.description = """
                After pressing ⌘S the Capture button greys out and never comes back.
                Switching devices re-enables it.
                """
        }
        let sampleURL = URL(string: "https://youtrack.example.com/issue/NIT-42")!
        switch state {
        case "editing":
            // The toggle and the discard dialog need the sheet on screen first.
            try? await Task.sleep(for: .seconds(1.5))
            feedback.setAttachesWindowImage(true)
            if let png = feedback.windowImagePNG, let path = ProcessInfo.processInfo.environment["NITPICK_SNAPSHOT_PATH"] {
                try? png.write(to: URL(fileURLWithPath: path).deletingPathExtension().appendingPathExtension("window-image.png"))
            }
        case "sending":
            feedback.phase = .sending
        case "sent":
            feedback.phase = .sent(SentFeedback(idReadable: "NIT-42", url: sampleURL))
        case "sent-warning":
            feedback.phase = .sent(SentFeedback(
                idReadable: "NIT-42",
                url: sampleURL,
                warnings: [
                    "The \(FeedbackKind.bug.tagName) tag could not be applied.",
                    "The window image could not be attached.",
                ]
            ))
        case "failed":
            feedback.phase = .failed(message: YouTrackError.permissionDenied(action: "create an issue in Nitpick").localizedDescription)
        case "failed-not-found":
            feedback.phase = .failed(message: YouTrackError.projectNotFound(shortName: AppCore.feedbackProjectShortName).localizedDescription)
        case "discard":
            try? await Task.sleep(for: .seconds(1.5))
            feedback.discardConfirmationRequested = true
        default:
            break
        }
        print("feedback snapshot: state=\(state) canSend=\(feedback.canSend) hasText=\(feedback.payload.hasText)")
        fflush(stdout)
    }
}
