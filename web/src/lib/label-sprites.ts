// A label's glyphs as the server flattens them (core's labelSpriteLayout).
// Engines anti-alias text differently and a browser may lack Helvetica, so
// the preview draws each label from the server's sprite, and its own text
// only until the sprite arrives.
import {
  drawAnnotation,
  labelSpriteLayout,
  type Annotation,
  type AnnotationCanvas,
  type AnnotationMetrics,
} from "@nitpick/core"

// A sprite's query names its pixels, so each one loads once per page.
const sprites = new Map<string, HTMLImageElement | "loading">()

/**
 * Draws `annotations` in stacking order as the server flattens them: labels
 * from their sprites, the rest through core/. `onSpriteLoaded` runs once a
 * sprite that was still loading arrives, to draw again.
 */
export function drawPreview(
  context: CanvasRenderingContext2D,
  annotations: ReadonlyArray<Annotation>,
  metrics: AnnotationMetrics,
  onSpriteLoaded: () => void
): void {
  for (const annotation of annotations) {
    if (annotation.kind === "label" && annotation.text !== "") {
      const layout = labelSpriteLayout(annotation.at, metrics)
      const sprite = labelSprite(
        new URLSearchParams({
          text: annotation.text,
          color: annotation.color,
          size: String(metrics.fontSize),
          offset: String(layout.offset),
        }),
        onSpriteLoaded
      )
      if (sprite !== undefined) {
        context.drawImage(sprite, layout.left, layout.top)
        continue
      }
    }
    drawAnnotation(context as AnnotationCanvas, annotation, metrics)
  }
}

function labelSprite(
  query: URLSearchParams,
  onLoaded: () => void
): HTMLImageElement | undefined {
  const url = `/api/label-sprite?${query}`
  const cached = sprites.get(url)
  if (cached instanceof HTMLImageElement) return cached
  if (cached === undefined) {
    sprites.set(url, "loading")
    const image = new Image()
    image.src = url
    image.decode().then(
      () => {
        sprites.set(url, image)
        onLoaded()
      },
      // The text stands in; a later draw asks again.
      () => sprites.delete(url)
    )
  }
  return undefined
}
