import { useEffect, useRef, useState } from "react"
import {
  filedIssueOf,
  findingsNeedingSummary,
  isEditable,
  trimWhitespaceAndNewlines,
  unfiledFindingCount,
  type TrayItem,
} from "@nitpick/core"
import type { SessionSummary } from "@nitpick/server/api"
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleAlertIcon,
  XIcon,
} from "lucide-react"
import { cn } from "cn"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { chords } from "@/lib/chords"
import type { Editor } from "@/lib/use-editor"

/**
 * The Tray, after Sources/Nitpick/TrayView.swift: rows newest first, the
 * needs-a-summary mark, Discard × on hover or selection behind a
 * confirmation (ADR-0010), filed and partly filed rows, and Previous and
 * Next Finding as visible controls.
 */
export function Tray({
  session,
  editor,
  onDiscard,
}: {
  readonly session: SessionSummary
  readonly editor: Editor
  readonly onDiscard: (itemID: string) => void
}) {
  const [pendingDiscard, setPendingDiscard] = useState<TrayItem>()
  const needingSummary = new Set(findingsNeedingSummary(session))
  const selectedID = editor.editor.target
  const selectedRow = useRef<HTMLLIElement>(null)

  // A jump, not an animated scroll, so reduced motion needs no branch.
  useEffect(() => {
    selectedRow.current?.scrollIntoView({ block: "nearest" })
  }, [selectedID])

  const summary = trimWhitespaceAndNewlines(
    pendingDiscard?.finding.summary ?? ""
  )

  return (
    <section aria-label="Tray" className="flex shrink-0 flex-col gap-1.5">
      <div className="flex items-center gap-1">
        <h2 className="text-xs font-medium text-muted-foreground uppercase">
          Tray
        </h2>
        <span className="ml-2 text-xs text-muted-foreground">
          {unfiledFindingCount(session)} unfiled
        </span>
        <span className="flex-1" />
        <StepButton
          label="Previous Finding"
          chord={chords.previousFinding.label}
          disabled={!editor.canStep("previous")}
          onClick={() => editor.step("previous")}
        >
          <ChevronUpIcon />
        </StepButton>
        <StepButton
          label="Next Finding"
          chord={chords.nextFinding.label}
          disabled={!editor.canStep("next")}
          onClick={() => editor.step("next")}
        >
          <ChevronDownIcon />
        </StepButton>
      </div>
      <ul className="max-h-64 overflow-y-auto">
        {session.tray.toReversed().map((item) => {
          const isSelected = item.id === selectedID
          return (
            <li
              key={item.id}
              ref={isSelected ? selectedRow : undefined}
              className={cn(
                "group/row flex h-8 animate-in items-center gap-2 rounded-md px-2.5 duration-200 fade-in slide-in-from-top-1 motion-reduce:animate-none",
                isSelected
                  ? "bg-accent ring-1 ring-foreground/10"
                  : "hover:bg-muted"
              )}
            >
              <button
                type="button"
                aria-current={isSelected ? "true" : undefined}
                onClick={() => editor.select(item.id)}
                className="@container flex min-w-0 flex-1 items-center gap-2 text-left text-sm outline-none focus-visible:underline"
              >
                <RowTitle item={item} isSelected={isSelected} />
              </button>
              <RowStatus
                item={item}
                needsSummary={needingSummary.has(item.id)}
                showsDiscard={isSelected}
                canDiscard={editor.canDiscard}
                onDiscard={() => setPendingDiscard(item)}
              />
            </li>
          )
        })}
      </ul>

      <AlertDialog
        open={pendingDiscard !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingDiscard(undefined)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard this Finding?</AlertDialogTitle>
            <AlertDialogDescription>
              Discarding {summary === "" ? "this Finding" : `“${summary}”`}{" "}
              removes it from the tray for good.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const item = pendingDiscard
                setPendingDiscard(undefined)
                if (item !== undefined) onDiscard(item.id)
              }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

/**
 * The summary, then the device model only when the row has room beside its
 * status: a model cut to "iPho…" says nothing, while a cut summary still
 * reads. CSS can't ask whether both fit whole, as ViewThatFits did, so the
 * title area's width decides.
 */
function RowTitle({
  item,
  isSelected,
}: {
  readonly item: TrayItem
  readonly isSelected: boolean
}) {
  const summary = trimWhitespaceAndNewlines(item.finding.summary)
  return (
    <>
      <span className={cn("truncate", isSelected && "font-medium")}>
        {summary === "" ? "Untitled Finding" : summary}
      </span>
      <span className="hidden shrink-0 text-muted-foreground @[16rem]:inline">
        {item.finding.deviceContext.deviceModel}
      </span>
    </>
  )
}

function RowStatus({
  item,
  needsSummary,
  showsDiscard,
  canDiscard,
  onDiscard,
}: {
  readonly item: TrayItem
  readonly needsSummary: boolean
  readonly showsDiscard: boolean
  readonly canDiscard: boolean
  readonly onDiscard: () => void
}) {
  const filed = filedIssueOf(item)
  if (filed !== undefined) {
    return (
      <span className="flex shrink-0 animate-in items-center gap-1 text-sm duration-200 zoom-in-50 motion-reduce:animate-none">
        <CheckIcon className="size-3.5 text-green-600" aria-hidden />
        <a
          href={filed.url}
          target="_blank"
          rel="noreferrer"
          className="underline-offset-4 hover:underline"
        >
          {filed.idReadable}
        </a>
      </span>
    )
  }
  if (!isEditable(item)) {
    // Mid-ladder: its Issue exists but is incomplete, and a File all retry
    // finishes it without re-creating anything (issue 08 files).
    return (
      <span className="shrink-0 text-sm text-amber-600">
        Filing interrupted — retry
      </span>
    )
  }
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {needsSummary && (
        <Tooltip>
          <TooltipTrigger
            render={
              <CircleAlertIcon
                role="img"
                aria-label="Needs a summary"
                className="size-4 fill-amber-500 text-background"
              />
            }
          />
          <TooltipContent>
            Needs a summary before it can be filed
          </TooltipContent>
        </Tooltip>
      )}
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Discard Finding"
        title="Discard Finding"
        disabled={!canDiscard}
        onClick={onDiscard}
        className={cn(
          "rounded-full text-muted-foreground",
          !showsDiscard &&
            "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
        )}
      >
        <XIcon />
      </Button>
    </span>
  )
}

function StepButton({
  label,
  chord,
  disabled,
  onClick,
  children,
}: {
  readonly label: string
  readonly chord: string
  readonly disabled: boolean
  readonly onClick: () => void
  readonly children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>
        {label} ({chord})
      </TooltipContent>
    </Tooltip>
  )
}
