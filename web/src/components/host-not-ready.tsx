import { ServerCrashIcon } from "lucide-react"
import { Button } from "@/components/ui/button"

/**
 * Stands in for the device picker while the Device Host can't run a review.
 * Reviewers can't fix the host, so it names the reason and offers a re-check;
 * the fix steps are in the ops runbook.
 */
export function HostNotReady({
  reason,
  disabled,
  onCheckAgain,
}: {
  readonly reason: string
  readonly disabled: boolean
  readonly onCheckAgain: () => void
}) {
  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-[10px] bg-amber/[0.07] p-3 ring-1 ring-amber/20"
    >
      <ServerCrashIcon className="mt-0.5 size-4 shrink-0 text-amber" />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-amber">
          Device Host not ready
        </p>
        <p className="text-[12.5px] text-text-2 select-text">{reason}</p>
      </div>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={onCheckAgain}
      >
        Check again
      </Button>
    </div>
  )
}
