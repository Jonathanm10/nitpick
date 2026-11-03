import { useEffect, useRef, useState } from "react"
import {
  filedIssueOf,
  findingsNeedingSummary,
  isEditable,
  trimWhitespaceAndNewlines,
  unfiledFindingCount,
  type TrayItem,
} from "@nitpick/core"
import type { FilingStatus, SessionSummary } from "@nitpick/server/api"
import {
  CameraIcon,
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
import { typeDotClass } from "@/components/finding-fields"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { api } from "@/lib/api"
import { chords } from "@/lib/chords"
import type { Editor } from "@/lib/use-editor"

/**
 * The Tray, after Sources/Nitpick/TrayView.swift: rows newest first, each
 * with its capture's thumbnail, the needs-a-summary mark, Discard × on hover or selection behind a
 * confirmation (ADR-0010), filed and partly filed rows, and Previous and
 * Next Finding as visible controls.
 */
export function Tray({
  session,
  filing,
  editor,
  onDiscard,
}: {
  readonly session: SessionSummary
  /** What a partly filed row says: filing now, the error, or retry. */
  readonly filing: FilingStatus
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
    <section aria-label="Tray" className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b pr-2 pl-4">
        <h2 className="studio-label">Tray</h2>
        <span className="ml-2 text-[11.5px] text-text-3">
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
      {session.tray.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <CameraIcon className="size-5 text-text-3" aria-hidden />
          <p className="text-[13px] font-medium">No Findings yet</p>
          <p className="text-[12px] text-text-3">
            Capture what&rsquo;s off on the device with {chords.capture.label}.
            Each capture lands here.
          </p>
        </div>
      ) : (
        <ul className="flex min-h-0 flex-1 thin-scroll flex-col gap-1 overflow-y-auto p-2">
          {session.tray.toReversed().map((item) => {
            const isSelected = item.id === selectedID
            return (
              <li
                key={item.id}
                ref={isSelected ? selectedRow : undefined}
                className={cn(
                  "group/row relative flex animate-in items-stretch gap-2.5 rounded-[9px] p-1.5 duration-200 fade-in slide-in-from-top-1 motion-reduce:animate-none",
                  isSelected
                    ? "bg-white/[0.07] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]"
                    : "hover:bg-white/[0.035]"
                )}
              >
                <button
                  type="button"
                  aria-current={isSelected ? "true" : undefined}
                  onClick={() => editor.select(item.id)}
                  className="flex min-w-0 flex-1 items-center gap-2.5 rounded-[7px] text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <img
                    src={api.captureURL(item.id)}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    draggable={false}
                    className="h-[60px] w-[28px] shrink-0 rounded-[5px] bg-black object-cover object-top ring-1 ring-white/10"
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <RowTitle item={item} isSelected={isSelected} />
                    <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-text-3">
                      <span
                        className={cn(
                          "size-[6px] shrink-0 rounded-full",
                          typeDotClass[item.finding.type]
                        )}
                      />
                      <span className="truncate">
                        {item.finding.deviceContext.deviceModel}
                      </span>
                    </span>
                  </span>
                </button>
                <RowStatus
                  item={item}
                  filing={filing}
                  needsSummary={needingSummary.has(item.id)}
                  showsDiscard={isSelected}
                  canDiscard={editor.canDiscard}
                  onDiscard={() => setPendingDiscard(item)}
                />
              </li>
            )
          })}
        </ul>
      )}

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

/** The summary, or "Untitled Finding" until it has one. */
function RowTitle({
  item,
  isSelected,
}: {
  readonly item: TrayItem
  readonly isSelected: boolean
}) {
  const summary = trimWhitespaceAndNewlines(item.finding.summary)
  return (
    <span
      className={cn(
        "truncate text-[13px] leading-[17px]",
        isSelected && "font-medium",
        summary === "" && "text-text-2 italic"
      )}
    >
      {summary === "" ? "Untitled Finding" : summary}
    </span>
  )
}

function RowStatus({
  item,
  filing,
  needsSummary,
  showsDiscard,
  canDiscard,
  onDiscard,
}: {
  readonly item: TrayItem
  readonly filing: FilingStatus
  readonly needsSummary: boolean
  readonly showsDiscard: boolean
  readonly canDiscard: boolean
  readonly onDiscard: () => void
}) {
  const filed = filedIssueOf(item)
  if (filed !== undefined) {
    return (
      <span className="flex shrink-0 animate-in items-center gap-1 self-center pr-1 font-mono text-[11.5px] text-green duration-200 zoom-in-50 motion-reduce:animate-none">
        <CheckIcon className="size-3.5" aria-hidden />
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
    // finishes it without re-creating anything. After a failed run this
    // row is where the failure lives, so it carries the error itself.
    if (filing.status === "running") {
      return (
        <span className="flex shrink-0 items-center gap-1.5 self-center pr-1 text-[11.5px] text-amber">
          <Spinner className="size-3" />
          Filing…
        </span>
      )
    }
    if (filing.status === "failed") {
      // The one status allowed to truncate: it splits the row with the
      // title, so neither is erased. The tooltip keeps the whole message.
      return (
        <span
          title={filing.error}
          className="w-20 shrink-0 self-center truncate pr-1 text-[11.5px] text-red"
        >
          {filing.error}
        </span>
      )
    }
    return (
      <span className="w-20 shrink-0 self-center pr-1 text-[11.5px] leading-tight text-amber">
        Filing interrupted — retry
      </span>
    )
  }
  return (
    <span className="flex shrink-0 flex-col items-end justify-between self-stretch">
      {needsSummary && (
        <Tooltip>
          <TooltipTrigger
            render={
              <CircleAlertIcon
                role="img"
                aria-label="Needs a summary"
                className="order-2 m-0.5 size-4 fill-amber text-background"
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
          "order-1 rounded-full text-text-3",
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
