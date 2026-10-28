import type { FilingPhase } from "@nitpick/core"
import { CheckIcon, CircleAlertIcon } from "lucide-react"
import { cn } from "cn"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { chords } from "@/lib/chords"

/**
 * File all under the Tray, after ContentView.swift's traySection: the
 * button names the phase, "File all (n)", "Filing k of n…", "File n
 * remaining" or "Filed n", and the line under it names the one blocker the
 * Reviewer acts on, selecting the first Finding without a summary.
 */
export function FileAll({
  phase,
  needingSummary,
  canFileAll,
  onFileAll,
  onSelect,
}: {
  readonly phase: FilingPhase
  readonly needingSummary: ReadonlyArray<string>
  readonly canFileAll: boolean
  readonly onFileAll: () => void
  readonly onSelect: (itemID: string) => void
}) {
  const reason =
    needingSummary.length === 0
      ? undefined
      : needsSummary(needingSummary.length)
  const allFiled = phase.phase === "allFiled"
  return (
    <div className="flex shrink-0 flex-col gap-1.5">
      <Tooltip>
        {/* A disabled button gets no hover, so its wrapper explains it. */}
        <TooltipTrigger render={<span tabIndex={-1} className="flex" />}>
          <Button
            size="lg"
            className={cn(
              "w-full",
              allFiled && "bg-green-600 text-white disabled:opacity-100"
            )}
            disabled={!canFileAll}
            onClick={onFileAll}
          >
            {phase.phase === "filing" && <Spinner />}
            {allFiled && <CheckIcon />}
            {label(phase)}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {reason ??
            `File every unfiled Finding to YouTrack (${chords.fileAll.label})`}
        </TooltipContent>
      </Tooltip>
      {/* The line keeps its height: a fresh capture starts blocked, and the
          first keystroke in Summary must not jolt the field. */}
      <div className="flex h-5 items-center">
        {reason !== undefined && (
          <button
            type="button"
            title="Select the first Finding that needs a summary"
            onClick={() => onSelect(needingSummary[0])}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <CircleAlertIcon
              aria-hidden
              className="size-4 fill-amber-500 text-background"
            />
            {reason}
          </button>
        )}
      </div>
    </div>
  )
}

function needsSummary(count: number): string {
  return count === 1
    ? "1 Finding needs a summary"
    : `${count} Findings need a summary`
}

function label(phase: FilingPhase): string {
  switch (phase.phase) {
    case "idle":
      return `File all (${phase.unfiled})`
    case "filing":
      return `Filing ${phase.completed} of ${phase.total}…`
    case "remaining":
      return `File ${phase.unfiled} remaining`
    case "allFiled":
      return `Filed ${phase.count}`
  }
}
