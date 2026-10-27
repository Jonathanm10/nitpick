import { useEffect, useState } from "react"

// A capture's bytes never change, so each one decodes once per page.
const decoded = new Map<string, Promise<HTMLImageElement>>()

function load(url: string): Promise<HTMLImageElement> {
  let image = decoded.get(url)
  if (image === undefined) {
    const element = new Image()
    element.src = url
    image = element.decode().then(() => element)
    // A failed load may succeed later, after a server restart say.
    image.catch(() => decoded.delete(url))
    decoded.set(url, image)
  }
  return image
}

export type CaptureImage =
  | { readonly status: "loading" }
  | { readonly status: "failed" }
  | { readonly status: "loaded"; readonly image: HTMLImageElement }

/** The decoded image at `url`, for drawing at its native pixels. */
export function useCaptureImage(url: string | undefined): CaptureImage {
  const [loaded, setLoaded] = useState<{
    readonly url: string
    readonly image: CaptureImage
  }>()
  useEffect(() => {
    if (url === undefined) return
    let current = true
    load(url).then(
      (image) => {
        if (current) setLoaded({ url, image: { status: "loaded", image } })
      },
      () => {
        if (current) setLoaded({ url, image: { status: "failed" } })
      }
    )
    return () => {
      current = false
    }
  }, [url])
  return loaded !== undefined && loaded.url === url
    ? loaded.image
    : { status: "loading" }
}
