# Inspect reads an iOS Build's layout from SwiftUI's debug tree

A designer asked to hover an element of the running Build and read its real layout values, as Figma's dev mode shows them for a design: size, padding, stack and grid spacing, font, colour, corner radius, and the names and values of the app's own components. nitpick reads them from the Build itself, on the simulator, with no change to the app.

## Decision

- **A library loaded at launch.** The server compiles `server/inspector/Inspector.m` with the Device Host's Xcode, once per source version, into its data directory; no binary is committed. `launchBuild` passes it to `simctl launch` as `SIMCTL_CHILD_DYLD_INSERT_LIBRARIES`, so the Build loads it. The library switches on `SWIFTUI_VIEW_DEBUG` before SwiftUI reads it.
- **SwiftUI's own debug tree, through private API.** Asked for a layout, the library calls `makeViewDebugData`, the Objective-C method Xcode's view debugger uses, on each SwiftUI hosting view on screen, and passes the JSON through as SwiftUI wrote it. It adds what the tree names by address but doesn't describe: fonts, with their weight and line height, and texts TextKit 2 lays out. A hosting view counts as on screen when it is drawn, lies on the screen, and no opaque hosting view drawn after it covers its whole frame: a full-screen cover hides the screen it covers, a sheet leaves its presenter showing.
- **Only the server talks to it.** The library listens on the simulator's loopback, which simulators share with the host, on a port the server chooses for each launch, and answers only the secret the server chooses for that launch. So two simulators never answer for each other, and nothing else on the host reads a layout. The page asks the server: `GET /api/session/layout`, for a signed-in Reviewer, reads the device they claimed when they started or resumed their review.
- **The server reads the tree.** It turns the tree, megabytes on a real screen, into a Layout Snapshot about a hundredth its size: one element per box a designer sees, with its frame in screen points and its values, so the page needs to know nothing of SwiftUI. The reading follows the spike that proved the technique on a real client Build: the coordinate rule, padding, stack and grid spacing, and fonts set through an app's own modifiers. A fictional sample app, Acme Store (`scripts/inspect-sample/`), records the fixtures its tests check against the app's source.

## Considered Options

- **Accessibility frames only.** `simctl` and XCUITest read the accessibility tree without loading anything into the app. Rejected: it has frames and labels, but no padding, spacing, fonts, colours or component values, which are what the designer asked for.
- **An SDK inside each app.** Each client app would link a nitpick package that reports its layout. Rejected: every client project would have to add, ship and update it, and a Build made without it, which is most of them, couldn't be inspected.
- **Loading a library at launch and reading SwiftUI's debug tree (chosen).**

## Consequences

- **Private API.** `makeViewDebugData` and the tree's shape are SwiftUI's internals, and an iOS release can change them. The fixtures pin what the server reads; after an Xcode or runtime update, they are recorded again on the new runtime and the tests rerun (`docs/operations.md`).
- **Simulator only.** `DYLD_INSERT_LIBRARIES` works on a simulator, not on a device. Android emulators answer that Inspect isn't available.
- **SwiftUI only.** UIKit views, a navigation bar's title among them, and screens SwiftUI doesn't draw give little or nothing. A SwiftUI view that only composes others, such as a row, has no element of its own; its parts do.
- **The first layout after a launch takes seconds** on a real Build, while SwiftUI makes its first debug pass; later ones take a fraction of a second, which the Build's main thread spends.
- **A host whose Xcode can't build the library** launches iOS Builds without it, and its health check says why.
- **ADR-0002 holds.** nitpick still boots, installs and launches the Build itself; the launch only gains environment variables, and the Build is the same file.
- **ADR-0003 holds.** Inspect reads the Build, never Figma, and renders no design: it shows the values a designer compares with the Design Reference themselves.
