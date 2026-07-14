// Renders assets/icon.svg into assets/AppIcon.icns via an .iconset.
// Run through `make icon` (or: swift scripts/make-icon.swift). The .icns is
// committed so the release ladder needs no rendering step.
import AppKit

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let svgURL = root.appendingPathComponent("assets/icon.svg")
let iconsetURL = root.appendingPathComponent("assets/AppIcon.iconset")
let icnsURL = root.appendingPathComponent("assets/AppIcon.icns")

guard let svg = NSImage(contentsOf: svgURL) else {
    fatalError("cannot load \(svgURL.path) — NSImage needs macOS 11+ for SVG")
}

try? FileManager.default.removeItem(at: iconsetURL)
try FileManager.default.createDirectory(at: iconsetURL, withIntermediateDirectories: true)

// The canonical iconset slots: (point size, scale).
let slots: [(Int, Int)] = [(16, 1), (16, 2), (32, 1), (32, 2),
                           (128, 1), (128, 2), (256, 1), (256, 2),
                           (512, 1), (512, 2)]
for (points, scale) in slots {
    let px = points * scale
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px,
                                     bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                     isPlanar: false, colorSpaceName: .deviceRGB,
                                     bytesPerRow: 0, bitsPerPixel: 0) else {
        fatalError("cannot allocate \(px)px bitmap")
    }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    svg.draw(in: NSRect(x: 0, y: 0, width: px, height: px),
             from: .zero, operation: .copy, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
    guard let png = rep.representation(using: .png, properties: [:]) else {
        fatalError("cannot encode \(px)px png")
    }
    let suffix = scale == 2 ? "@2x" : ""
    try png.write(to: iconsetURL.appendingPathComponent("icon_\(points)x\(points)\(suffix).png"))
}

let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["-c", "icns", iconsetURL.path, "-o", icnsURL.path]
try iconutil.run()
iconutil.waitUntilExit()
guard iconutil.terminationStatus == 0 else { fatalError("iconutil failed") }
try? FileManager.default.removeItem(at: iconsetURL)
print("make-icon: wrote \(icnsURL.path)")
