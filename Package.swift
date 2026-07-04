// swift-tools-version: 6.1
import PackageDescription

let package = Package(
    name: "nitpick",
    platforms: [.macOS(.v15)],
    dependencies: [
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.6.0")
    ],
    targets: [
        // The app core: one deep module behind a public API, receiving the
        // single effects seam (subprocess, HTTP transport, credential store).
        .target(name: "NitpickCore"),
        // The thin SwiftUI shell.
        .executableTarget(
            name: "Nitpick",
            dependencies: [
                "NitpickCore",
                .product(name: "Sparkle", package: "Sparkle"),
            ]
        ),
        .testTarget(
            name: "NitpickCoreTests",
            dependencies: ["NitpickCore"]
        ),
    ]
)
