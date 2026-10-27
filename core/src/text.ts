/**
 * Swift's `.whitespacesAndNewlines`: Unicode spaces (Zs), tab, U+000A–U+000D,
 * U+0085, U+200B, U+2028 and U+2029. Unlike JS's `trim`, it trims U+0085 and
 * U+200B and keeps U+FEFF. All of them are single UTF-16 code units.
 */
const whitespaceOrNewline = /^[\p{Zs}\t\n\v\f\r\u0085\u200b\u2028\u2029]$/u

/**
 * Swift's `trimmingCharacters(in: .whitespacesAndNewlines)`. Scans in from
 * each end, one code unit at a time: an anchored `\s+$`-style regex
 * backtracks quadratically over a long inner run of spaces, and this text
 * comes from the browser.
 */
export function trimWhitespaceAndNewlines(text: string): string {
  let start = 0
  let end = text.length
  while (start < end && whitespaceOrNewline.test(text[start])) start++
  while (end > start && whitespaceOrNewline.test(text[end - 1])) end--
  return text.slice(start, end)
}

export function isBlank(text: string): boolean {
  return trimWhitespaceAndNewlines(text) === ""
}
