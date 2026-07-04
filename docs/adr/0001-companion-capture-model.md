# Companion capture model, not an embedded mirror

Nitpick does not render the device screen itself. The designer runs whatever mirror they already use (Simulator.app, iPhone Mirroring, Bezel), and nitpick captures from it on demand. Owning the mirror (USB `AVCaptureDevice` feed or embedded simulator stream) would mean rebuilding Bezel before delivering any review value; the companion model makes device-vs-simulator a per-review choice instead of an architectural commitment.

## Consequences

- Each Capture Source brings its own capture mechanism and metadata adapter. The simulator captures via `simctl io <udid> screenshot` — native device pixels, no Screen Recording permission, no window cropping. Window-based sources (iPhone Mirroring, Bezel) capture via ScreenCaptureKit and need window discovery, cropping, and the Screen Recording permission — deferred until those sources ship.
- Capture of the iPhone Mirroring window is unverified (spike required before that source ships); if it fails, the fallback is a minimal owned USB-feed viewer for the device path only.
