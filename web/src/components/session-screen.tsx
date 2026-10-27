import type { BuildSummary, SessionSummary } from "@nitpick/server/api"
import { Button } from "@/components/ui/button"
import { DevicePicker } from "@/components/device-picker"
import { HostNotReady } from "@/components/host-not-ready"
import { StartReviewButton } from "@/components/start-review-button"
import type { useReview } from "@/lib/use-review"

/**
 * The open Review Session: the Build and project in the header, then the
 * top bar with the Device Context, the status and Resume review while
 * paused. Capture, the Editor and the Tray arrive with issue 07.
 */
export function SessionScreen({
  build,
  session,
  model,
  onEndReview,
}: {
  readonly build: BuildSummary
  readonly session: SessionSummary
  readonly model: ReturnType<typeof useReview>
  readonly onEndReview: () => void
}) {
  const { host, run, isBusy } = model
  return (
    <div className="flex flex-1 flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">{build.name}</h1>
        <p className="text-sm text-muted-foreground">
          {build.identity.version} ({build.identity.buildNumber}) ·{" "}
          {session.project.name}
        </p>
      </div>
      {host.status === "notReady" ? (
        <HostNotReady
          reason={host.reason}
          disabled={isBusy}
          onCheckAgain={model.checkHostAgain}
        />
      ) : (
        <div className="flex min-h-11 items-center gap-3 rounded-xl border bg-muted/40 py-1.5 pr-2 pl-1.5">
          <DevicePicker
            variant="chip"
            devices={model.devices}
            recentDeviceUDIDs={model.recentDeviceUDIDs}
            selected={model.selectedDevice ?? run?.device}
            onSelect={model.selectDevice}
            disabled={isBusy}
          />
          <span className="h-4.5 w-px bg-border" />
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <span
              className={`size-2 rounded-full ${run ? "bg-green-500" : "bg-muted-foreground/40"}`}
            />
            {run ? "Review in progress" : "Ready to resume"}
          </span>
          <span className="flex-1" />
          {run === undefined && (
            <StartReviewButton
              title={model.startTitle}
              missing={model.missingForStart}
              onStart={model.startReview}
            />
          )}
        </div>
      )}
      <div className="flex flex-1 items-center justify-center rounded-xl border-2 border-dashed bg-muted/30 p-6 text-center text-lg text-muted-foreground">
        {run
          ? `The Build is running on ${run.device.name} on the Device Host.`
          : "Resume review to capture"}
      </div>
      <div className="flex justify-end">
        <Button variant="outline" disabled={isBusy} onClick={onEndReview}>
          End Review
        </Button>
      </div>
    </div>
  )
}
