// History import: the Swift app's schema v1 History files, or a zip of its
// history folder, brought into the shared History. Not a port: Swift had no
// import. The files are the stored-history golden and fictional entries
// encoded as Swift writes them, which the goldens pin byte for byte.
import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import {
  decodeStoredHistoryEntry,
  encodeStoredHistoryEntry,
  MalformedStoredData,
  UnsupportedStoredSchema,
  type HistoryEntry,
  type YouTrackUser,
} from "@nitpick/core"
import { describe, expect, test } from "vitest"
import {
  goldenInput,
  goldenText,
  historyEntryFrom,
  type DescribedHistoryEntry,
} from "../../core/test/golden.ts"
import type { HistoryImportResponse, HistoryResponse } from "../src/api.ts"
import { HistoryStore } from "../src/historyStore.ts"
import { nodeSubprocessRunner } from "../src/subprocess.ts"
import { temporaryDirectory } from "./BuildFixtures.ts"
import { FakeDeviceHost } from "./FakeDeviceHost.ts"
import { signedInApp, vera } from "./SignedIn.ts"

const noor: YouTrackUser = { login: "noor", fullName: "Noor Haddad" }

const goldenFile = goldenText("stored-history-entry/history-entry.json")
const goldenEntry = historyEntryFrom(
  goldenInput<{ historyEntry: DescribedHistoryEntry }>(
    "stored-history-entry/history-entry.input.json"
  ).historyEntry
)
const goldenSession = goldenText("stored-session/annotations.json")

/** A fictional session the Swift app filed, `startedAt` seconds after 2001. */
function filedSession(
  startedAt: number,
  issueIDs: ReadonlyArray<string>
): HistoryEntry {
  return {
    ...goldenEntry,
    startedAt,
    findings: issueIDs.map((idReadable, index) => ({
      ...goldenEntry.findings[index % 2],
      issue: {
        idReadable,
        url: `https://youtrack.example.com/yt/issue/${idReadable}`,
      },
    })),
  }
}

/** The bytes the Swift app's recordInHistory writes for `entry`. */
function swiftFile(entry: HistoryEntry): string {
  return encodeStoredHistoryEntry(entry)
}

function harness(
  options: { readonly data?: string; readonly user?: YouTrackUser } = {}
) {
  const data = options.data ?? temporaryDirectory()
  return {
    data,
    ...signedInApp({
      data,
      deviceHost: new FakeDeviceHost([]),
      runner: nodeSubprocessRunner,
      user: options.user,
    }),
  }
}

type Chosen = { readonly name: string; readonly contents: string | Uint8Array }

async function importFiles(
  h: ReturnType<typeof harness>,
  files: ReadonlyArray<Chosen>
): Promise<HistoryImportResponse> {
  const response = await post(h, files)
  expect(response.status).toBe(200)
  return (await response.json()) as HistoryImportResponse
}

function post(h: ReturnType<typeof harness>, files: ReadonlyArray<Chosen>) {
  const form = new FormData()
  for (const { name, contents } of files) {
    form.append(
      "files",
      new File(
        [typeof contents === "string" ? contents : Buffer.from(contents)],
        name
      )
    )
  }
  return h.app.request("/api/history/import", { method: "POST", body: form })
}

async function historyOf(h: ReturnType<typeof harness>) {
  const response = await h.app.request("/api/history")
  return ((await response.json()) as HistoryResponse).entries
}

/** Every file in the History directory, by name, with its bytes. */
function storedFiles(h: ReturnType<typeof harness>): Record<string, string> {
  const directory = h.history.directory
  if (!existsSync(directory)) return {}
  return Object.fromEntries(
    readdirSync(directory)
      .sort()
      .map((name) => [name, readFileSync(join(directory, name), "utf8")])
  )
}

const goldenName = "2026-07-04T09-15-32.473Z.json"

describe("Importing History files", () => {
  test("the History golden imports as filed by the importer, stored like an entry File all records", async () => {
    const h = harness()

    const { results } = await importFiles(h, [
      { name: goldenName, contents: goldenFile },
    ])

    expect(results).toEqual([{ file: goldenName, outcome: "imported" }])
    expect(await historyOf(h)).toEqual([{ ...goldenEntry, filedBy: vera }])
    // File all records the same session under the same name, with the same
    // bytes: the page can't tell the two apart, and neither can a re-import.
    const native = new HistoryStore(join(temporaryDirectory(), "history"))
    await native.record({ ...goldenEntry, filedBy: vera })
    const [name] = readdirSync(native.directory)
    expect(name).toMatch(/_vera\.json$/)
    expect(storedFiles(h)).toEqual({
      [name]: readFileSync(join(native.directory, name), "utf8"),
    })
  })

  test("an imported entry keeps its Issue links, summaries, Device Contexts and Design References exactly", async () => {
    const h = harness()
    const unusual: HistoryEntry = {
      ...filedSession(804849400.1250001, ["RM-430", "RM-431"]),
      findings: [
        {
          summary: "Tab bar «Profil» overlaps the 🏠 icon",
          description: 'Line one\nline two and a / slash, "quoted"',
          deviceContext: {
            deviceModel: "iPad Pro 13-inch (M5)",
            osName: "iPadOS 26.4",
            accessibilitySettings: ["Dynamic Type AX3", "Dark Mode"],
          },
          designReference: "https://www.figma.com/file/xyz789/Tabs?node-id=1-2",
          issue: {
            idReadable: "RM-430",
            url: "https://youtrack.example.com/yt/issue/RM-430",
          },
        },
        {
          summary: "",
          description: "",
          deviceContext: {
            deviceModel: "iPhone 17",
            osName: "iOS 26.4",
            accessibilitySettings: [],
          },
          issue: {
            idReadable: "RM-431",
            url: "https://youtrack.example.com/yt/issue/RM-431",
          },
        },
      ],
    }

    await importFiles(h, [
      { name: goldenName, contents: goldenFile },
      { name: "unusual.json", contents: swiftFile(unusual) },
    ])

    const stored = Object.values(storedFiles(h)).map(decodeStoredHistoryEntry)
    expect(stored).toEqual([
      { ...goldenEntry, filedBy: vera },
      { ...unusual, filedBy: vera },
    ])
    // Without the importer, each is the Swift app's file byte for byte.
    expect(
      stored.map((entry) =>
        encodeStoredHistoryEntry({ ...entry, filedBy: undefined })
      )
    ).toEqual([goldenFile, swiftFile(unusual)])
  })

  test("importing the same set twice changes nothing the second time", async () => {
    const h = harness()
    const set: Chosen[] = [
      { name: goldenName, contents: goldenFile },
      {
        name: "b.json",
        contents: swiftFile(filedSession(804900000, ["RM-440"])),
      },
      {
        name: "c.json",
        contents: swiftFile(filedSession(805000000, ["RM-450", "RM-451"])),
      },
      { name: "broken.json", contents: "{" },
    ]
    const first = await importFiles(h, set)
    const afterFirst = storedFiles(h)

    const second = await importFiles(h, set)

    expect(first.results.map((result) => result.outcome)).toEqual([
      "imported",
      "imported",
      "imported",
      "refused",
    ])
    expect(second.results.map((result) => result.outcome)).toEqual([
      "duplicate",
      "duplicate",
      "duplicate",
      "refused",
    ])
    expect(Object.keys(afterFirst)).toHaveLength(3)
    expect(storedFiles(h)).toEqual(afterFirst)
  })

  test("a corrupt file and one with an unknown schema are reported by name with today's messages, and the others still import", async () => {
    const h = harness()
    const later = filedSession(804900000, ["RM-440"])

    const { results } = await importFiles(h, [
      { name: goldenName, contents: goldenFile },
      { name: "truncated.json", contents: goldenFile.slice(0, 80) },
      {
        name: "from-a-newer-nitpick.json",
        contents: goldenFile.replace('"schemaVersion":1', '"schemaVersion":2'),
      },
      {
        name: "no-findings.json",
        contents: goldenFile.replace('"findings"', '"filings"'),
      },
      { name: "not-utf8.json", contents: Uint8Array.from([0x7b, 0xff, 0x7d]) },
      { name: "later.json", contents: swiftFile(later) },
    ])

    expect(results).toEqual([
      { file: goldenName, outcome: "imported" },
      {
        file: "truncated.json",
        outcome: "refused",
        error: new MalformedStoredData("it is not JSON").message,
      },
      {
        file: "from-a-newer-nitpick.json",
        outcome: "refused",
        error: new UnsupportedStoredSchema(2).message,
      },
      {
        file: "no-findings.json",
        outcome: "refused",
        error: new MalformedStoredData("findings is missing").message,
      },
      {
        file: "not-utf8.json",
        outcome: "refused",
        error: new MalformedStoredData("it is not JSON").message,
      },
      { file: "later.json", outcome: "imported" },
    ])
    expect(await historyOf(h)).toEqual([
      { ...later, filedBy: vera },
      { ...goldenEntry, filedBy: vera },
    ])
  })

  test("an open session isn't imported, and says so", async () => {
    const h = harness()

    const { results } = await importFiles(h, [
      { name: "session.json", contents: goldenSession },
    ])

    expect(results).toEqual([{ file: "session.json", outcome: "openSession" }])
    expect(storedFiles(h)).toEqual({})
  })

  test("a file that is neither History nor a zip is refused by name", async () => {
    const h = harness()

    const { results } = await importFiles(h, [
      { name: "notes.txt", contents: goldenFile },
    ])

    expect(results).toEqual([
      {
        file: "notes.txt",
        outcome: "refused",
        error:
          "“notes.txt” isn't a History file. Choose the .json files in the Swift app's history folder, or a zip of that folder.",
      },
    ])
  })
})

describe("Duplicates", () => {
  test("the same session start with the same Issue IDs, in any order and whoever filed it, is a duplicate", async () => {
    const h = harness()
    const session = filedSession(804900000, ["RM-440", "RM-441"])
    await h.history.record({
      ...filedSession(804900000, ["RM-441", "RM-440"]),
      filedBy: noor,
    })

    const { results } = await importFiles(h, [
      { name: "a.json", contents: swiftFile(session) },
    ])

    expect(results).toEqual([{ file: "a.json", outcome: "duplicate" }])
    expect(Object.keys(storedFiles(h))).toEqual([
      "2026-07-04T23-20-00.000Z_noor.json",
    ])
  })

  test("the same start with other Issue IDs is another session", async () => {
    const h = harness()
    await h.history.record({
      ...filedSession(804900000, ["RM-440"]),
      filedBy: noor,
    })

    const { results } = await importFiles(h, [
      {
        name: "a.json",
        contents: swiftFile(filedSession(804900000, ["RM-440", "RM-441"])),
      },
    ])

    expect(results).toEqual([{ file: "a.json", outcome: "imported" }])
    expect(await historyOf(h)).toHaveLength(2)
  })

  test("a file chosen twice in one import is added once", async () => {
    const h = harness()

    const { results } = await importFiles(h, [
      { name: goldenName, contents: goldenFile },
      { name: "copy.json", contents: goldenFile },
    ])

    expect(results).toEqual([
      { file: goldenName, outcome: "imported" },
      { file: "copy.json", outcome: "duplicate" },
    ])
    expect(await historyOf(h)).toHaveLength(1)
  })

  test("the importer's own session from the same moment with other Issues is never written over", async () => {
    const h = harness()
    const native = { ...filedSession(804900000, ["RM-440"]), filedBy: vera }
    await h.history.record(native)

    const { results } = await importFiles(h, [
      {
        name: "a.json",
        contents: swiftFile(filedSession(804900000, ["RM-499"])),
      },
    ])

    expect(results).toEqual([
      {
        file: "a.json",
        outcome: "refused",
        error:
          "History already holds another session you filed that started at the same moment.",
      },
    ])
    expect(await historyOf(h)).toEqual([native])
  })

  test("two imports of the same files at once add each entry once", async () => {
    const h = harness()
    const set: Chosen[] = [
      { name: goldenName, contents: goldenFile },
      {
        name: "b.json",
        contents: swiftFile(filedSession(804900000, ["RM-440"])),
      },
    ]

    const [first, second] = await Promise.all([
      importFiles(h, set),
      importFiles(h, set),
    ])

    // Whichever came first added both; the other found both there.
    expect(
      [first, second]
        .map(({ results }) => results.map((result) => result.outcome).join())
        .sort()
    ).toEqual(["duplicate,duplicate", "imported,imported"])
    expect(Object.keys(storedFiles(h))).toHaveLength(2)
  })

  test("every Reviewer sees an imported entry, as filed by its importer", async () => {
    const h = harness()
    await importFiles(h, [{ name: goldenName, contents: goldenFile }])

    const other = harness({ data: h.data, user: noor })

    expect(await historyOf(other)).toEqual([{ ...goldenEntry, filedBy: vera }])
  })
})

describe.runIf(process.platform === "darwin")(
  "Importing a zip of the history folder, with the host's bsdtar",
  () => {
    function zip(
      folder: string,
      archive: string,
      tool: "ditto" | "zip" = "ditto"
    ): Uint8Array {
      if (tool === "ditto") {
        // As Finder's Compress does: metadata goes in __MACOSX.
        execFileSync("/usr/bin/ditto", [
          "-c",
          "-k",
          "--sequesterRsrc",
          "--keepParent",
          folder,
          archive,
        ])
      } else {
        // -y keeps a symlink a symlink.
        execFileSync("/usr/bin/zip", ["-q", "-r", "-y", archive, "."], {
          cwd: folder,
        })
      }
      return readFileSync(archive)
    }

    test("its .json files import in name order, the open session says so, and macOS metadata and other files are skipped", async () => {
      const h = harness()
      const temp = temporaryDirectory()
      const folder = join(temp, "Nitpick")
      mkdirSync(join(folder, "history"), { recursive: true })
      mkdirSync(join(folder, "open-session", "captures"), { recursive: true })
      writeFileSync(join(folder, "history", goldenName), goldenFile)
      const later = filedSession(804900000, ["RM-440"])
      writeFileSync(
        join(folder, "history", "2026-07-04T23-20-00.000Z.json"),
        swiftFile(later)
      )
      writeFileSync(join(folder, "history", "broken.json"), "{")
      writeFileSync(join(folder, "history", ".hidden.json"), goldenFile)
      writeFileSync(join(folder, "open-session", "session.json"), goldenSession)
      writeFileSync(join(folder, "open-session", "captures", "x.png"), "png")
      execFileSync("/usr/bin/xattr", [
        "-w",
        "com.example.note",
        "fictional",
        join(folder, "history", goldenName),
      ])
      const bytes = zip(folder, join(temp, "Nitpick.zip"))

      const { results } = await importFiles(h, [
        { name: "Nitpick.zip", contents: bytes },
      ])

      expect(results).toEqual([
        {
          file: `Nitpick.zip › Nitpick/history/${goldenName}`,
          outcome: "imported",
        },
        {
          file: "Nitpick.zip › Nitpick/history/2026-07-04T23-20-00.000Z.json",
          outcome: "imported",
        },
        {
          file: "Nitpick.zip › Nitpick/history/broken.json",
          outcome: "refused",
          error: new MalformedStoredData("it is not JSON").message,
        },
        {
          file: "Nitpick.zip › Nitpick/open-session/session.json",
          outcome: "openSession",
        },
      ])
      expect(await historyOf(h)).toEqual([
        { ...later, filedBy: vera },
        { ...goldenEntry, filedBy: vera },
      ])
      // The zip and what it held are gone once read.
      expect(readdirSync(join(h.directory, "imports"))).toEqual([])
    })

    test("a symlink in the zip is never followed", async () => {
      const h = harness()
      const temp = temporaryDirectory()
      const outside = join(temp, "outside.json")
      writeFileSync(outside, goldenFile)
      const folder = join(temp, "history")
      mkdirSync(folder)
      symlinkSync(outside, join(folder, "linked.json"))
      writeFileSync(
        join(folder, "real.json"),
        swiftFile(filedSession(804900000, ["RM-440"]))
      )
      const bytes = zip(folder, join(temp, "history.zip"), "zip")

      const { results } = await importFiles(h, [
        { name: "history.zip", contents: bytes },
      ])

      expect(results).toEqual([
        { file: "history.zip › real.json", outcome: "imported" },
      ])
      expect(await historyOf(h)).toHaveLength(1)
    })

    test("a zip that won't open, or holds no .json files, is refused by name and the other files still import", async () => {
      const h = harness()
      const temp = temporaryDirectory()
      const folder = join(temp, "captures")
      mkdirSync(folder)
      writeFileSync(join(folder, "x.png"), "png")
      const noHistory = zip(folder, join(temp, "captures.zip"))

      const { results } = await importFiles(h, [
        { name: "History.zip", contents: "not a zip at all" },
        { name: "captures.zip", contents: noHistory },
        { name: goldenName, contents: goldenFile },
      ])

      expect(results).toEqual([
        {
          file: "History.zip",
          outcome: "refused",
          error: "“History.zip” can't be opened as a zip.",
        },
        {
          file: "captures.zip",
          outcome: "refused",
          error:
            "“captures.zip” holds no .json files. Zip the Swift app's history folder.",
        },
        { file: goldenName, outcome: "imported" },
      ])
      expect(readdirSync(join(h.directory, "imports"))).toEqual([])
    })
  }
)

describe("The import request", () => {
  test("one without files is malformed", async () => {
    const h = harness()

    const response = await h.app.request("/api/history/import", {
      method: "POST",
      body: new FormData(),
    })

    expect(response.status).toBe(400)
  })
})
