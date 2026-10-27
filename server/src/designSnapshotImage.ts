// The byte checks of DesignSnapshot.validated in
// Sources/NitpickCore/DesignSnapshot.swift: the image must decode, and be the
// media type its file name claims. Decoded with Skia, as flattening does.
import { loadImage } from "@napi-rs/canvas"
import {
  DesignSnapshotError,
  type DesignSnapshotMediaType,
} from "@nitpick/core"

/**
 * Throws `unreadableImage` when the bytes don't decode, and
 * `mediaTypeMismatch` when they decode as another type than `mediaType`.
 */
export async function checkDesignSnapshotImage(
  data: Uint8Array,
  mediaType: DesignSnapshotMediaType
): Promise<void> {
  try {
    await loadImage(Buffer.from(data))
  } catch {
    throw new DesignSnapshotError({ kind: "unreadableImage" })
  }
  if (detectedMediaType(data) !== mediaType) {
    throw new DesignSnapshotError({
      kind: "mediaTypeMismatch",
      expected: mediaType,
    })
  }
}

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function detectedMediaType(
  data: Uint8Array
): DesignSnapshotMediaType | undefined {
  if (pngSignature.every((byte, index) => data[index] === byte)) return "png"
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "jpeg"
  return undefined
}
