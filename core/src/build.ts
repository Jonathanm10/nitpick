/**
 * What identifies a Build: bundle ID, version, and build number, read from the
 * bundle's Info.plist, never typed by the designer (ADR-0002). An Android
 * Build's are its package name, version name and version code, read from
 * the APK.
 */
export interface BuildIdentity {
  /** The iOS bundle ID, or the Android package name. */
  readonly bundleID: string
  readonly version: string
  readonly buildNumber: string
}

/** A specific compiled instance of the app under review. */
export interface Build {
  readonly identity: BuildIdentity
  /**
   * The .app bundle on the Device Host, as a `file://` URL ending in `/`, or
   * the uploaded .apk itself, as a `file://` URL ending in `.apk`.
   */
  readonly appBundleURL: string
}

/** Which devices run a Build: iOS simulators or Android emulators. */
export type DevicePlatform = "ios" | "android"

/** An Android Build is its .apk file; an iOS Build, its .app folder. */
export function buildPlatform(build: {
  readonly appBundleURL: string
}): DevicePlatform {
  return build.appBundleURL.endsWith(".apk") ? "android" : "ios"
}

/** A device's platform: Android emulators say so, iOS simulators don't. */
export function devicePlatform(device: {
  readonly platform?: "android"
}): DevicePlatform {
  return device.platform ?? "ios"
}
