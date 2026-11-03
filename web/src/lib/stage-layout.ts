// The stage's geometry: its measured size, where the live device fits, and
// the move between the middle of the stage and its picture-in-picture
// corner.
import { useLayoutEffect, useRef, useState, type RefObject } from "react"
import type { DevicePlatform } from "@nitpick/core"

export interface Size {
  readonly width: number
  readonly height: number
}

/** The element's content box, kept current by a ResizeObserver. */
export function useElementSize(ref: RefObject<HTMLElement | null>): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    const observer = new ResizeObserver(([entry]) => {
      setSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return size
}

/** A stream's pixel size before its first frame says otherwise. */
export function defaultScreen(platform: DevicePlatform | undefined): Size {
  return platform === "android"
    ? { width: 1080, height: 2424 }
    : { width: 1206, height: 2622 }
}

/** Room under the screen: Home (and Back), then Capture. */
const controlsHeight = 32 + 52
const stageInset = 28

/** The picture-in-picture device's width: narrower on a narrow stage. */
export function pipWidth(stage: Size): number {
  return stage.width >= 760 ? 184 : stage.width >= 560 ? 152 : 128
}

/**
 * The device's outer width in the middle of the stage: as tall as the stage
 * allows, never wider than it.
 */
export function stageDeviceWidth(stage: Size, screen: Size): number {
  const aspect = screen.width / screen.height
  const byHeight = (stage.height - stageInset * 2 - controlsHeight) * aspect
  const byWidth = stage.width - stageInset * 2
  return Math.max(140, Math.floor(Math.min(byHeight, byWidth)))
}

/** The bezel and the screen's corner radius for a device `width` wide. */
export function deviceChrome(
  width: number,
  screen: Size,
  platform: DevicePlatform | undefined
) {
  const bezel = Math.min(10, Math.max(4, Math.round(width * 0.028)))
  const isTablet = screen.width / screen.height > 0.6
  const ratio = platform === "android" ? 0.07 : isTablet ? 0.04 : 0.115
  const screenRadius = Math.round((width - bezel * 2) * ratio)
  return { bezel, screenRadius, outerRadius: screenRadius + bezel }
}

/**
 * Animates the element from where it was to where it is, whenever `key`
 * changes (FLIP). The element stays mounted, so a live stream inside it
 * never reconnects. Reduced motion jumps.
 */
export function useFlip(ref: RefObject<HTMLElement | null>, key: unknown) {
  const last = useRef<{ rect: DOMRect; key: unknown }>(undefined)
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    for (const animation of element.getAnimations()) animation.cancel()
    const rect = element.getBoundingClientRect()
    const before = last.current
    last.current = { rect, key }
    if (
      before === undefined ||
      before.key === key ||
      rect.width === 0 ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return
    }
    const scale = before.rect.width / rect.width
    const dx = before.rect.left - rect.left
    const dy = before.rect.top - rect.top
    element.animate(
      [
        {
          transformOrigin: "top left",
          transform: `translate(${dx}px, ${dy}px) scale(${scale})`,
        },
        { transformOrigin: "top left", transform: "none" },
      ],
      { duration: 420, easing: "cubic-bezier(0.32, 0.72, 0, 1)" }
    )
  })
}
