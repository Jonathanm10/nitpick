// Reads the subsets of YouTrack's JSON that core uses, as Swift's Decodable
// payload structs do: a required field must be present with the right type,
// an optional one may be missing or null, and other fields are ignored. A
// mismatch throws PayloadMismatch.

export class PayloadMismatch extends Error {
  constructor(expected: string) {
    super(`YouTrack's response is not ${expected}`)
    this.name = "PayloadMismatch"
  }
}

export type PayloadObject = Readonly<Record<string, unknown>>

export function payloadObject(value: unknown): PayloadObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PayloadMismatch("an object")
  }
  return value as PayloadObject
}

export function payloadArray(value: unknown): ReadonlyArray<unknown> {
  if (!Array.isArray(value)) throw new PayloadMismatch("a list")
  return value
}

export function requiredString(object: PayloadObject, key: string): string {
  const value = object[key]
  if (typeof value !== "string") throw new PayloadMismatch(`a ${key}`)
  return value
}

export function optionalString(
  object: PayloadObject,
  key: string
): string | undefined {
  const value = object[key]
  return value === undefined || value === null
    ? undefined
    : requiredString(object, key)
}

export function optionalObject(
  object: PayloadObject,
  key: string
): PayloadObject | undefined {
  const value = object[key]
  return value === undefined || value === null
    ? undefined
    : payloadObject(value)
}

export function optionalArray(
  object: PayloadObject,
  key: string
): ReadonlyArray<unknown> | undefined {
  const value = object[key]
  return value === undefined || value === null ? undefined : payloadArray(value)
}
