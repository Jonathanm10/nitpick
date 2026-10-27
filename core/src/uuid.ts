// Web Crypto's randomUUID is a global in Node and in browsers alike, so core
// can use it; ES2023's lib just doesn't declare it.
declare const crypto: { randomUUID(): string }

/** A fresh UUID, uppercase as Swift's `UUID().uuidString` writes it. */
export function newUUID(): string {
  return crypto.randomUUID().toUpperCase()
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The UUID a string spells, uppercased, or undefined. Swift's
 * `UUID(uuidString:)` takes either case and always writes uppercase.
 */
export function parseUUID(text: string): string | undefined {
  return uuidPattern.test(text) ? text.toUpperCase() : undefined
}
