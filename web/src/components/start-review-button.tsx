import { cn } from "cn"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { chords } from "@/lib/chords"

/**
 * Start review, or Resume review once a session is open: one of the two
 * red buttons, with its chord. Disabled, its tooltip names what's missing.
 */
export function StartReviewButton({
  title,
  missing,
  onStart,
  size = "sm",
  className,
}: {
  readonly title: string
  /** Why it can't start, or undefined when it can. */
  readonly missing: string | undefined
  readonly onStart: () => void
  /** `lg` is home's full-width button; `sm` sits in the session's top bar. */
  readonly size?: "sm" | "lg"
  readonly className?: string
}) {
  const button = (
    <Button
      size={size === "lg" ? "lg" : "sm"}
      disabled={missing !== undefined}
      onClick={onStart}
      className={cn(
        "border-0 font-semibold btn-red",
        size === "lg" && "h-11 w-full rounded-[10px] text-[14px]",
        className
      )}
    >
      {title}
      <Kbd className="bg-white/20 text-white/90 in-disabled:bg-white/5 in-disabled:text-text-3">
        {chords.startReview.label}
      </Kbd>
    </Button>
  )
  if (missing === undefined) return button
  // A disabled button gets no pointer events, so the tooltip hangs on a
  // wrapper that keyboard users can reach too.
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            className={cn("inline-flex", size === "lg" && "flex w-full")}
          />
        }
      >
        {button}
      </TooltipTrigger>
      <TooltipContent>{missing}</TooltipContent>
    </Tooltip>
  )
}
