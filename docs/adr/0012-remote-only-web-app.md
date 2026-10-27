# Nitpick is a remote-only web app on a shared Device Host

Nitpick moves from a macOS SwiftUI app to a web app (React + shadcn/ui), served by a Liip office Mac mini that also runs the iOS simulators and Android emulators. That machine is the Device Host, and every reviewer opens one URL in a browser. Three needs drove the move. A designer wants shadcn/ui components, so they can work on UX instead of on component polish. Some POs at Liip use Windows. And reviewers must be able to review iOS and Android Builds from a Mac or a Windows machine. Windows cannot run an iOS simulator, so a Mac has to host the devices whatever the client is; putting all of nitpick on that Mac means nothing installs on a reviewer's machine. The device's screen is streamed into the page, so capture becomes a button next to it.

This supersedes ADR-0001 (nitpick now shows the device itself), ADR-0005 (Android runs on the same host), ADR-0006 (no global hotkey) and ADR-0010 (web idioms, not AppKit ones).

## Considered Options

- **Appetize or EAS cloud simulators.** Rejected: client Builds would leave Liip, and it costs a subscription.
- **Electron with local devices.** Rejected: more moving parts (per-OS builds, signing, an updater, `simctl` and `adb` on every reviewer's machine), and Windows still can't run iOS.
- **Phone mirroring.** Rejected: no Build provenance (ADR-0002) and no device metadata, and iPhone mirroring on Windows needs third-party AirPlay receivers.
- **Staying native SwiftUI.** Rejected: macOS only.
- **Remote-only web app on a shared Device Host (chosen).**

## Consequences

- **Dropped:** Electron, `simctl` and `adb` on the reviewer's machine, app signing and notarization, Sparkle, a Windows build, and the global capture hotkey. A reviewer needs only a browser. The full Xcode that ADR-0002 requires moves to the Device Host.
- **Streaming copies T3 Code's design.** `expo-device-hub` streams the devices: serve-sim for iOS, serve-emu for Android. The design follows T3 Code (github.com/pingdotgg/t3code, MIT; read at commit `36d4d71`): `docs/internals/devices.md`, `apps/server/src/device/DeviceHost.ts`, `apps/server/src/device/DeviceHubProxy.ts`, and the viewer's protocol code in `packages/client-runtime/src/device/stream.ts` (which `devices.md` still links as `deviceStream.ts`).
- **The hub is never exposed.** It listens only on the host's loopback interface. The only way in is an authenticating proxy in the nitpick server, which allowlists the stream and read routes. serve-sim's shell-exec token can be read from its unauthenticated `/api`, so one exposed hub port would hand out command execution on the host.
- **Device settings use typed actions.** Any device setting the page offers runs as a typed `simctl` or `adb` action in the nitpick server, never through the hub's exec channel. Simulator.app's menus can't be reached from a browser. The Device Context stamp is still read back at capture (ADR-0009).
- **The stream needs HTTPS.** The viewer decodes H.264 with WebCodecs, which browsers offer only in a secure context (HTTPS or localhost). iOS can fall back to MJPEG; Android has no fallback. The URL must therefore be served over HTTPS.
- **What holds.**
  - nitpick installs and launches the Build itself (ADR-0002). The Build now arrives by upload instead of a drop on a local app.
  - The Finding image is still `simctl io screenshot` on the host, at native pixels, and never a stream frame.
  - Accessibility is still read with `simctl ui` (ADR-0009).
  - The metadata block contract (ADR-0004) and the YouTrack triage fields (ADR-0008) are unchanged.
- **Device Host is a seam.** Everything that depends on the machine running the devices sits behind it. The same server could later run on a designer's Mac to bring local devices back. Nothing is built for that now.
- **Login and data.**
  - Proposed: a reviewer signs in with their YouTrack token, which the server checks against YouTrack's current-user endpoint. There are no separate accounts.
  - Review Sessions and History move to the server and become shared.
  - Existing History (stored JSON, schema v1, see `Sources/NitpickCore/SessionPersistence.swift`) is imported.
- **Host operations.**
  - Two Mac minis on the office LAN, no longer needed for CI.
  - The main host is the 16 GB M1, once its last CI user moves to Bitrise. FileVault is off, so it can reboot on a schedule.
  - The fallback is the 8 GB M2 with Xcode 26.2. FileVault is on, so a reboot needs someone at the machine.
  - macOS's 49.7-day `tcp_now` bug: after about 49.7 days of uptime, TIME_WAIT sockets pile up until no new TCP connection can open. It happened on the M2 at 189 days. The host reboots well before 49 days.
  - Host memory bounds how many devices run at once: one simulator plus the hub took free memory on the 8 GB mini from 77% to 37%.
- **Spike results (2026-10-27).** Run on the M2 with an iPhone 17 Pro simulator on iOS 26.2, with the hub reached over an SSH tunnel:
  - The first stream frame arrived in 1.85 s.
  - JPEG frames came at the native 1206×2622, about 370 KB each, and about 1.8 MB/s while the screen changes.
  - A remote `simctl` capture came back in 0.67 s.
  - Requests without the token got 401.
  - Verdict: a small lag when an app opens, fine after that, and keyboard input works.
- **The repo is public.** Host IPs, hostnames, account names, tokens and server config are never committed. Docs say "a Liip office Mac mini".
- **One repo, two apps for a while.** The web app's code lives in its own folders next to `Sources/`. The Swift app keeps getting fixes until the web app reaches parity, and is then deleted.
- **Design follows the running app.** The first build uses shadcn/ui's default look and today's flows. The designer then reviews the running app, and can mock changes up in shadcn's official Figma kit.
