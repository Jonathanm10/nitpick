// Pins the JSONEncoder output that core/test/golden/README.md says no golden
// holds. Each expectation is what Swift's JSONEncoder, with sorted keys and
// unescaped slashes, wrote for the same value on macOS 27.
import { describe, expect, test } from "vitest"
import { encodeSwiftJSON } from "../src/swiftJSON.ts"

describe("Swift's JSONEncoder output", () => {
  test.each([
    [0, "0"],
    [-0, "-0"],
    [60, "60"],
    [-3.5, "-3.5"],
    [804849332.4729061, "804849332.4729061"],
    [0.0001, "0.0001"],
    [0.00012, "0.00012"],
    [0.00001, "1e-05"],
    [0.0000123, "1.23e-05"],
    [1e-7, "1e-07"],
    [5e-324, "5e-324"],
    [1e15, "1000000000000000"],
    [2 ** 53, "9007199254740992"],
    [1e16, "1e+16"],
    [2 ** 54, "1.8014398509481984e+16"],
    [1e21, "1e+21"],
    [1.7976931348623157e308, "1.7976931348623157e+308"],
  ])("the number %d is written as %s", (value, written) => {
    expect(encodeSwiftJSON([value])).toBe(`[${written}]`)
  })

  test("keys sort by their bytes", () => {
    expect(
      encodeSwiftJSON({ a: 1, _0: 2, B: 3, b_: 4, Z: 5, ab: 6, aB: 7 })
    ).toBe('{"B":3,"Z":5,"_0":2,"a":1,"aB":7,"ab":6,"b_":4}')
  })

  test("strings escape only quotes, backslashes and control characters", () => {
    const text = 'a/b\u0001\u007f\u2028\u0085"\\\t\b\f\u00e9\u{1f600}'
    expect(encodeSwiftJSON(text)).toBe(
      '"a/b\\u0001\u007f\u2028\u0085\\"\\\\\\t\\b\\f\u00e9\u{1f600}"'
    )
  })

  test("absent optional values are left out", () => {
    expect(encodeSwiftJSON({ kept: "yes", absent: undefined })).toBe(
      '{"kept":"yes"}'
    )
  })
})
