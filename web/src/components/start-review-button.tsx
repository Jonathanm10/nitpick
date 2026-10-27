import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/**
 * Start review, or Resume review once a session is open. Disabled, its
 * tooltip names what's missing.
 */
export function StartReviewButton({
  title,
  missing,
  onStart,
}: {
  readonly title: string
  /** Why it can't start, or undefined when it can. */
  readonly missing: string | undefined
  readonly onStart: () => void
}) {
  const button = (
    <Button disabled={missing !== undefined} onClick={onStart}>
      {title}
    </Button>
  )
  if (missing === undefined) return button
  // A disabled button gets no pointer events, so the tooltip hangs on a
  // wrapper that keyboard users can reach too.
  return (
    <Tooltip>
      <TooltipTrigger render={<span tabIndex={0} className="inline-flex" />}>
        {button}
      </TooltipTrigger>
      <TooltipContent>{missing}</TooltipContent>
    </Tooltip>
  )
}
