# Measured on the deployed server (8 GB M2, Xcode 26.2, iPhone 17 Pro simulator on iOS 26.2)

From headless Chromium on another Mac over the office LAN (VPN). Plain HTTP, so no secure context and no WebCodecs: the stream is MJPEG.

| Number | Deployed (this issue) | Spike (2026-10-27, SSH tunnel) | Issue 09 (64 GB dev Mac, loopback) |
| --- | --- | --- | --- |
| First frame after the stream request, warm device | median 2.79 s (5 runs: 2.79, 3.79, 2.79, 2.29, 2.79) | 1.85 s | 1.79 s |
| Resume click to first frame, warm device | median 3.92 s (5 runs) | — | 2.93 s |
| First frame after the stream request, right after a cold boot | 3.30 s and 3.38 s (7.30 s on the very first boot of a new simulator) | — | 2.3 s (fresh hub) |
| Start review click to "Review in progress" (boot, install, launch), cold | 18.9 s, 20.0 s, 20.4 s | — | 7.2 s (provisioned device) |
| Capture click to response | median 0.55 s (10 runs: 0.51–0.80 s) | 0.67 s | 0.66 s |
| Capture size | 1206×2622 native | 1206×2622 | 1206×2622 |

Free memory on the host (`memory_pressure`, plus free+inactive+speculative pages):

| State | Free | Available |
| --- | --- | --- |
| No device booted | 74% | 4.59 GB |
| One device booted and streaming | 54% | 2.26 GB |
| (first run) no device → one streaming | 73% → 48% | 4.41 → 1.93 GB |
| Spike | 77% → 37% | — |

Keyboard input on Xcode 26.2: "Hello, nitpick 42!" typed through the stream reached the device's text field, Shift and "!" included (see `capture.png`).
