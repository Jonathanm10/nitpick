import { ServerCrashIcon } from "lucide-react"
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert"
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
    <Alert>
      <ServerCrashIcon />
      <AlertTitle>Device Host not ready</AlertTitle>
      <AlertDescription>{reason}</AlertDescription>
      <AlertAction>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={onCheckAgain}
        >
          Check again
        </Button>
      </AlertAction>
    </Alert>
  )
}
