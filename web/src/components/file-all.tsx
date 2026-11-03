import type { FilingPhase } from "@nitpick/core"
import { CheckIcon, CircleAlertIcon } from "lucide-react"
import { cn } from "cn"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Spinner } from "@/components/ui/spinner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { chords } from "@/lib/chords"

/**
 * File all at the Tray's foot, after ContentView.swift's traySection: the
 * button names the phase, "File all (n)", "Filing k of n…", "File n
 * remaining" or "Filed n", and the notice over it names the one blocker the
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
    <div className="flex shrink-0 flex-col gap-2 border-t p-3">
      {/* The notice keeps its height: a fresh capture starts blocked, and
          the first keystroke in Summary must not jolt the Tray. */}
      <div className="flex h-8 items-center">
        {reason !== undefined && (
          <button
            type="button"
            title="Select the first Finding that needs a summary"
            onClick={() => onSelect(needingSummary[0])}
            className="flex h-8 w-full items-center gap-2 rounded-[8px] bg-amber/[0.08] px-2.5 text-left text-[12px] text-amber ring-1 ring-amber/20 hover:bg-amber/[0.12]"
          >
            <CircleAlertIcon
              aria-hidden
              className="size-4 shrink-0 fill-amber text-background"
            />
            <span className="flex-1 truncate">{reason}</span>
            <span className="text-amber/80 max-xl:hidden">Show</span>
          </button>
        )}
      </div>
      <Tooltip>
        {/* A disabled button gets no hover, so its wrapper explains it. */}
        <TooltipTrigger render={<span tabIndex={-1} className="flex" />}>
          <Button
            size="lg"
            className={cn(
              "h-9 w-full rounded-[9px] font-semibold",
              allFiled &&
                "bg-green/15 text-green ring-1 ring-green/30 disabled:opacity-100"
            )}
            disabled={!canFileAll}
            onClick={onFileAll}
          >
            {phase.phase === "filing" && <Spinner />}
            {allFiled && <CheckIcon />}
            {label(phase)}
            {phase.phase !== "filing" && !allFiled && (
              <Kbd className="bg-black/10 text-primary-foreground/60">
                {chords.fileAll.label}
              </Kbd>
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {reason ??
            `File every unfiled Finding to YouTrack (${chords.fileAll.label})`}
        </TooltipContent>
      </Tooltip>
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
