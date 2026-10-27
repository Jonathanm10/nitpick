// UTF-8 and byte joining for request and response bodies. TextEncoder and
// TextDecoder are globals in Node and in browsers alike, so core can use
// them; ES2023's lib just doesn't declare them.
declare const TextEncoder: new () => { encode(text: string): Uint8Array }
declare const TextDecoder: new (
  label: "utf-8",
  options: { fatal: boolean }
) => { decode(bytes: Uint8Array): string }

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/** Throws on bytes that aren't UTF-8, as Swift's JSONDecoder does. */
export function decodeUTF8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
}

export function concatBytes(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const joined = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0)
  )
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.length
  }
  return joined
}
