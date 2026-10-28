// Where a device's screen sits inside its stream element, shared by the
// simulator and emulator views: a pointer maps into it as a finger would.

/** Marks the stream's element, which Return to the Build focuses. */
export const streamAttribute = "data-device-stream"

/** How long a wheel gesture may pause before its drag lets go. */
export const wheelRelease = 120

/**
 * Where the screen shows inside the element: the whole of it, or centred
 * between bars when the column is too short for the device.
 */
export function shownScreen(
  bounds: DOMRect,
  screen: { readonly width: number; readonly height: number }
) {
  const scale = Math.min(
    bounds.width / screen.width,
    bounds.height / screen.height
  )
  const width = screen.width * scale
  const height = screen.height * scale
  return {
    left: bounds.left + (bounds.width - width) / 2,
    top: bounds.top + (bounds.height - height) / 2,
    width,
    height,
  }
}

export function pointIn(
  bounds: {
    readonly left: number
    readonly top: number
    readonly width: number
    readonly height: number
  },
  event: { readonly clientX: number; readonly clientY: number }
) {
  return {
    x: clamp((event.clientX - bounds.left) / bounds.width),
    y: clamp((event.clientY - bounds.top) / bounds.height),
  }
}

export function clamp(value: number): number {
  return Math.min(1, Math.max(0, value))
}
