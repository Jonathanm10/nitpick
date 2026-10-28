# Android reviews run on the Device Host, streamed over WebRTC

Android Builds are reviewed on the same Device Host and page as iOS ones (ADR-0012). An Android Build is the uploaded `.apk`: its identity is the package name, version name and version code that `aapt2 dump badging` reads from it. The server boots an AVD headless (`emulator -avd <name> -no-window -no-audio -no-boot-anim`), installs the APK with `adb install -r -t -d` and opens its launcher activity, all as typed actions, never through the hub. An older version of the app, or one signed with another key, is uninstalled and replaced, as `simctl install` replaces one. The finding image is `adb exec-out screencap -p` at native pixels, never a stream frame.

## The metadata block

Its line shapes don't change (ADR-0004). The package name fills `App:`'s ID slot, and `Device:` names the AVD as the AVD Manager shows it (its `avd.ini.displayname`) with the Android release of its system image: `Device: Pixel 10 — Android 17`.

The Accessibility tokens mirror the iOS ones in meaning and order (PRD answer 8), each left out at its default, and are read back with `adb` at capture (ADR-0009):

| Setting | Read with | Token | Default, left out |
| --- | --- | --- | --- |
| Font size | `settings get system font_scale` | `Font Size 130%`: the scale as a whole percentage | 100%, or unset (`null`) |
| Dark theme | `dumpsys uimode`, `mComputedNightMode` | `Dark Mode`, the iOS token: the same meaning | off |
| High-contrast text | `settings get secure high_text_contrast_enabled` | `High Contrast Text` | off, or unset |

`Dark Mode` reuses the iOS token because the setting means the same, so a reader of the block needs one token per meaning. High-contrast text is not iOS's Increase Contrast (it outlines text rather than raising UI contrast), so it gets its own token. The dark theme is read from the computed night mode, because `cmd uimode night` names a schedule (`custom_bedtime`, `auto`), not what is in effect. A value that can't be parsed reads as its default, so the line never carries a raw value. The tokens are additive, as Increase Contrast was: no schema version bump.

## Streaming

serve-emu, in the same pinned hub as serve-sim, streams the emulator's H.264 over WebRTC. Browsers decode WebRTC without a secure context, unlike WebCodecs, so Android streams over plain HTTP on the LAN (PRD answer 6), where iOS falls back to MJPEG. The viewer's input goes as JSON gestures on serve-emu's WebSocket, which the proxy opens with `video=0`.

serve-emu's action routes have no auth of their own (install, launch, files, text, screenshot, AVD start and stop). The proxy allowlists only `webrtc/offer` and `webrtc/close` (POST, the methods WebRTC signaling needs, with an emulator serial as `device`) and the input socket. Everything else under serve-emu is a 404, with or without a sign-in. A POST or socket from another origin is a 403.

The media doesn't flow through the proxy. After the authenticated offer and answer, the browser and the hub's WebRTC publisher (libdatachannel) connect directly over UDP, to the host candidates the answer lists. The hub's HTTP port still listens on loopback only. A UDP port opens per viewer session, and only the browser that holds the session's ICE credentials and DTLS fingerprint, exchanged over the authenticated proxy, can complete the connection.

## Consequences

- The Device Host needs the Android SDK (platform-tools, the emulator, a system image, build-tools for `aapt2`), at least one AVD, and an `ffmpeg` with libx264, which serve-emu encodes the emulator's screen with. The health check names the first one missing. iOS reviews go on without them.
- The server and the hub find them in the standard environment: `ANDROID_HOME` (else `~/Library/Android/sdk`), `ANDROID_AVD_HOME` (else `~/.android/avd`), and `SERVE_EMU_FFMPEG` (else `ffmpeg` on `PATH` or in Homebrew's prefixes).
- An emulator outlives the request that booted it, as a simulator does. One that doesn't finish booting within three minutes is shut down with `adb emu kill`.
- The WebRTC publisher uses `node-datachannel`'s prebuilt binary, so its install script now runs. serve-emu downloads its scrcpy server on first use, and its default ICE servers include a public STUN server, which a LAN doesn't need.
