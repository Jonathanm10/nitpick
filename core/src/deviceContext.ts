/**
 * The simulator's preferred content size categories, smallest first, named
 * as `simctl ui <device> content_size` takes them.
 */
export const dynamicTypeSizes = [
  "extra-small",
  "small",
  "medium",
  "large",
  "extra-large",
  "extra-extra-large",
  "extra-extra-extra-large",
  "accessibility-medium",
  "accessibility-large",
  "accessibility-extra-large",
  "accessibility-extra-extra-large",
  "accessibility-extra-extra-extra-large",
] as const

export type DynamicTypeSize = (typeof dynamicTypeSizes)[number]

const dynamicTypeDisplayNames: Record<DynamicTypeSize, string> = {
  "extra-small": "XS",
  small: "S",
  medium: "M",
  large: "L",
  "extra-large": "XL",
  "extra-extra-large": "XXL",
  "extra-extra-extra-large": "XXXL",
  "accessibility-medium": "AX1",
  "accessibility-large": "AX2",
  "accessibility-extra-large": "AX3",
  "accessibility-extra-extra-large": "AX4",
  "accessibility-extra-extra-extra-large": "AX5",
}

/**
 * A size's name in the metadata block's Accessibility line: Apple's HIG
 * vocabulary, part of the ADR-0004 contract.
 */
export function dynamicTypeDisplayName(size: DynamicTypeSize): string {
  return dynamicTypeDisplayNames[size]
}

/** As `simctl ui <device> appearance` takes it. */
export type Appearance = "light" | "dark"

/**
 * The accessibility state read back from the device at capture (ADR-0009):
 * the settings half of a Device Context.
 */
export interface DeviceSettings {
  readonly dynamicTypeSize: DynamicTypeSize
  readonly appearance: Appearance
  readonly increaseContrast: boolean
}

/** iOS's defaults, which the Accessibility line leaves out. */
export const defaultDeviceSettings: DeviceSettings = {
  dynamicTypeSize: "large",
  appearance: "light",
  increaseContrast: false,
}

/**
 * The non-default settings in the metadata block's order: Dynamic Type, Dark
 * Mode, Increase Contrast. Empty when everything is default.
 */
export function accessibilityDescriptions(settings: DeviceSettings): string[] {
  const descriptions: string[] = []
  if (settings.dynamicTypeSize !== defaultDeviceSettings.dynamicTypeSize) {
    descriptions.push(
      `Dynamic Type ${dynamicTypeDisplayName(settings.dynamicTypeSize)}`
    )
  }
  if (settings.appearance === "dark") descriptions.push("Dark Mode")
  if (settings.increaseContrast) descriptions.push("Increase Contrast")
  return descriptions
}

/**
 * The device and settings in effect when a Finding is captured. Stamped per
 * Finding, not on the Review Session.
 */
export interface DeviceContext {
  /** e.g. "iPhone 17 Pro". */
  readonly deviceModel: string
  /** e.g. "iOS 26.4". */
  readonly osName: string
  /**
   * The non-default accessibility settings, in display order. Empty leaves
   * the Accessibility line out of the metadata block.
   */
  readonly accessibilitySettings: ReadonlyArray<string>
}

/** The Device Context every capture stamps: the device under its settings. */
export function deviceContextOf(
  device: { readonly name: string; readonly osName: string },
  settings: DeviceSettings = defaultDeviceSettings
): DeviceContext {
  return {
    deviceModel: device.name,
    osName: device.osName,
    accessibilitySettings: accessibilityDescriptions(settings),
  }
}
