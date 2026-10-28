// Reads a Feedback the page sends, from untrusted multipart parts: the JSON
// of a FeedbackRequest and an optional image, which the Issue carries as a
// PNG (Sources/Nitpick/FeedbackSheet.swift attached the window as one).
import { createCanvas, loadImage, type Image } from "@napi-rs/canvas"
import type { FeedbackEnvironment, FeedbackKind } from "@nitpick/core"
import type { FeedbackRequest } from "./api.ts"
import { parseAnnotations } from "./findingPatch.ts"

/** The request isn't a Feedback the server can send. */
export class MalformedFeedback extends Error {
  constructor(problem: string) {
    super(`The Feedback can't be sent: ${problem}.`)
    this.name = "MalformedFeedback"
  }
}

const kinds: ReadonlyArray<FeedbackKind> = ["bug", "improvement"]

const environmentKeys: ReadonlyArray<keyof FeedbackEnvironment> = [
  "nitpick",
  "webApp",
  "server",
  "browser",
  "macOS",
  "xcode",
  "deviceHostMacOS",
  "deviceHostXcode",
  "build",
  "captureSource",
]

export function parseFeedbackRequest(json: unknown): FeedbackRequest {
  let body: unknown
  try {
    body = typeof json === "string" ? JSON.parse(json) : undefined
  } catch {
    // Reported below as a missing object.
  }
  const fields = object(body, "the feedback part")
  if (!kinds.includes(fields.kind as FeedbackKind)) fail("its kind is unknown")
  const environment = object(fields.environment, "its environment")
  for (const [key, value] of Object.entries(environment)) {
    if (!environmentKeys.includes(key as keyof FeedbackEnvironment)) {
      fail(`environment.${key} is not an Environment line`)
    }
    string(value, `environment.${key}`)
  }
  return {
    kind: fields.kind as FeedbackKind,
    title: string(fields.title, "its title"),
    description: string(fields.description, "its description"),
    environment: environment as FeedbackEnvironment,
    imageAnnotations:
      fields.imageAnnotations === undefined
        ? undefined
        : parseAnnotations(fields.imageAnnotations, "imageAnnotations"),
  }
}

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/**
 * The attached image as PNG bytes: a PNG passes through unchanged, and any
 * other image the rasterizer decodes, such as a JPEG, is re-encoded.
 */
export async function feedbackImagePNG(data: Uint8Array): Promise<Uint8Array> {
  let image: Image
  try {
    image = await loadImage(Buffer.from(data))
  } catch {
    throw new MalformedFeedback("the image can't be read. Attach a PNG or JPEG")
  }
  if (pngSignature.every((byte, index) => data[index] === byte)) return data
  const canvas = createCanvas(image.width, image.height)
  canvas.getContext("2d").drawImage(image, 0, 0)
  return canvas.encode("png")
}

function object(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${what} is not an object`)
  }
  return value as Record<string, unknown>
}

function string(value: unknown, what: string): string {
  if (typeof value !== "string") fail(`${what} is not text`)
  return value
}

function fail(problem: string): never {
  throw new MalformedFeedback(problem)
}
