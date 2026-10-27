/**
 * A moment as Swift's `Date` stores it: seconds since 2001-01-01T00:00:00Z,
 * Swift's reference date. Kept as Swift's exact double, because a JS `Date`
 * holds only milliseconds and a stored session must round-trip byte for
 * byte. A Review Session's start is also its identity (ADR-0004).
 */
export type ReferenceDate = number

/** The Unix time of Swift's reference date, in seconds. */
const referenceDateEpoch = 978_307_200

export function referenceDate(date: Date): ReferenceDate {
  return date.getTime() / 1000 - referenceDateEpoch
}

/**
 * ISO 8601 in UTC, truncated to whole seconds, as Swift's
 * `Date.formatted(.iso8601)` writes it: "2026-07-04T09:15:32Z".
 */
export function iso8601(date: ReferenceDate): string {
  const unixSeconds = Math.floor(date) + referenceDateEpoch
  return new Date(unixSeconds * 1000).toISOString().replace(".000Z", "Z")
}
