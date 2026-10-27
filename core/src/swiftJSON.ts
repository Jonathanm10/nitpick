// Writes JSON exactly as Swift's JSONEncoder does with `.sortedKeys` and
// `.withoutEscapingSlashes`, the encoder the stored session and History files
// come from (core/test/golden/README.md).

export type SwiftJSONValue =
  | string
  | number
  | boolean
  | ReadonlyArray<SwiftJSONValue>
  | { readonly [key: string]: SwiftJSONValue | undefined }

/** No whitespace; object keys sorted by their bytes; undefined left out. */
export function encodeSwiftJSON(value: SwiftJSONValue): string {
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number") return swiftNumber(value)
  if (typeof value === "boolean") return String(value)
  if (isArray(value)) return `[${value.map(encodeSwiftJSON).join(",")}]`
  const members = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    // Code-unit order, which is byte order for the stored shapes' ASCII keys.
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${encodeSwiftJSON(value[key] as SwiftJSONValue)}`
    )
  return `{${members.join(",")}}`
}

// Array.isArray doesn't narrow a ReadonlyArray out of a union.
function isArray(
  value: SwiftJSONValue
): value is ReadonlyArray<SwiftJSONValue> {
  return Array.isArray(value)
}

/**
 * Swift's `Double.description` without a trailing ".0". JS picks the same
 * shortest digits, but Swift switches to exponent form below 1e-4 and above
 * 2^53, writes at least two exponent digits with a sign, and keeps -0.
 */
function swiftNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${value} has no JSON form`)
  }
  if (value === 0) return Object.is(value, -0) ? "-0" : "0"
  const [digits, exponent] = value.toExponential().split("e")
  const power = Number(exponent)
  if (power >= -4 && Math.abs(value) <= 2 ** 53) return String(value)
  const sign = power < 0 ? "-" : "+"
  return `${digits}e${sign}${String(Math.abs(power)).padStart(2, "0")}`
}
