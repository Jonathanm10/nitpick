/**
 * What identifies a Build: bundle ID, version, and build number, read from the
 * bundle's Info.plist, never typed by the designer (ADR-0002).
 */
export interface BuildIdentity {
  readonly bundleID: string
  readonly version: string
  readonly buildNumber: string
}

/** A specific compiled instance of the app under review. */
export interface Build {
  readonly identity: BuildIdentity
  /** The .app bundle on the Device Host, as a `file://` URL ending in `/`. */
  readonly appBundleURL: string
}
