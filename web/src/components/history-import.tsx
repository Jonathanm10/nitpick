import { useRef, useState } from "react"
import type { HistoryImportResult } from "@nitpick/server/api"
import { ImportIcon, InfoIcon, TriangleAlertIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"
import { isApplePlatform } from "@/lib/chords"

type Phase =
  | { readonly phase: "choosing" }
  | { readonly phase: "importing" }
  | {
      readonly phase: "imported"
      readonly results: ReadonlyArray<HistoryImportResult>
    }
  | { readonly phase: "failed"; readonly message: string }

/** Where the Swift app kept its History (Sources/Nitpick/AppModel.swift). */
const swiftHistoryFolder = "~/Library/Application Support/Nitpick/history"

/**
 * "Import History…" on the History page and its dialog: the Reviewer
 * chooses the History files their Swift app wrote, or a zip of its history
 * folder, and sees what became of each. The server reads every file with
 * the schema v1 codec, skips sessions History already holds, and names each
 * file it refused. Every opening starts afresh.
 */
export function HistoryImportButton({
  onImported,
}: {
  readonly onImported: () => void
}) {
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<Phase>({ phase: "choosing" })
  const picker = useRef<HTMLInputElement>(null)
  const importing = phase.phase === "importing"

  async function importFiles(files: ReadonlyArray<File>) {
    setPhase({ phase: "importing" })
    try {
      const { results } = await api.importHistory(files)
      setPhase({ phase: "imported", results })
      if (results.some((result) => result.outcome === "imported")) {
        onImported()
      }
    } catch (error) {
      setPhase({ phase: "failed", message: (error as Error).message })
    }
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="ml-auto"
        onClick={() => {
          setPhase({ phase: "choosing" })
          setOpen(true)
        }}
      >
        <ImportIcon />
        Import History…
      </Button>
      <Dialog open={open} onOpenChange={(next) => importing || setOpen(next)}>
        <DialogContent showCloseButton={!importing} className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Import History</DialogTitle>
            <DialogDescription>
              Bring in the sessions your Swift app filed. Choose the .json files
              in its history folder, or a zip of that folder. Sessions already
              in History are skipped, and imported ones show you as who filed
              them.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1 rounded-lg bg-muted px-3 py-2">
            <code className="font-mono text-xs select-text">
              {swiftHistoryFolder}
            </code>
            {isApplePlatform && (
              <span className="text-xs text-muted-foreground">
                In the file dialog, press ⇧⌘G and paste this path.
              </span>
            )}
          </div>
          <p className="flex gap-2 text-muted-foreground">
            <InfoIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
            Open Review Sessions aren't imported. File or end them in the Swift
            app first.
          </p>
          <div aria-live="polite" className="contents">
            {phase.phase === "imported" && (
              <ImportResults results={phase.results} />
            )}
            {phase.phase === "failed" && (
              <p role="alert" className="text-destructive select-text">
                {phase.message}
              </p>
            )}
          </div>
          <input
            ref={picker}
            type="file"
            accept=".json,.zip,application/json,application/zip"
            multiple
            hidden
            onChange={(event) => {
              const files = [...(event.target.files ?? [])]
              event.target.value = ""
              if (files.length > 0) void importFiles(files)
            }}
          />
          <DialogFooter className="items-center">
            {phase.phase === "imported" && (
              <Button variant="outline" onClick={() => setOpen(false)}>
                Done
              </Button>
            )}
            <Button
              variant={phase.phase === "imported" ? "secondary" : "default"}
              disabled={importing}
              onClick={() => picker.current?.click()}
            >
              {importing ? (
                <>
                  <Spinner />
                  Importing…
                </>
              ) : phase.phase === "imported" ? (
                "Import more…"
              ) : (
                "Choose files…"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/**
 * How many sessions came in and how many History already held, then each
 * file that wasn't imported, by name, with why.
 */
function ImportResults({
  results,
}: {
  readonly results: ReadonlyArray<HistoryImportResult>
}) {
  const imported = results.filter((result) => result.outcome === "imported")
  const duplicates = results.filter((result) => result.outcome === "duplicate")
  const notImported = results.filter(
    (
      result
    ): result is Extract<
      HistoryImportResult,
      { outcome: "refused" | "openSession" }
    > => result.outcome === "refused" || result.outcome === "openSession"
  )
  return (
    <div className="flex flex-col gap-2">
      <p className="font-medium">
        {imported.length === 0
          ? "Nothing new was imported."
          : `Imported ${sessions(imported.length)}.`}
        {duplicates.length > 0 &&
          ` ${sessions(duplicates.length)} ${duplicates.length === 1 ? "was" : "were"} already in History.`}
      </p>
      {notImported.length > 0 && (
        <ul
          aria-label="Files not imported"
          className="flex max-h-56 flex-col gap-2 overflow-y-auto"
        >
          {notImported.map((result, index) => (
            <li key={index} className="flex gap-2">
              {result.outcome === "openSession" ? (
                <InfoIcon
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  aria-hidden
                />
              ) : (
                <TriangleAlertIcon
                  className="mt-0.5 size-4 shrink-0 text-destructive"
                  aria-hidden
                />
              )}
              <div className="flex min-w-0 flex-col select-text">
                <span className="font-mono text-xs break-all">
                  {result.file}
                </span>
                <span className="text-muted-foreground">
                  {result.outcome === "openSession"
                    ? "An open Review Session, not imported. File or end it in the Swift app first, then import its History file."
                    : result.error}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function sessions(count: number): string {
  return count === 1 ? "1 session" : `${count} sessions`
}
