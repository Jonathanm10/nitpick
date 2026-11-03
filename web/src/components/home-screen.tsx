import { CommandIcon } from "lucide-react"
import { BuildDropZone } from "@/components/build-drop-zone"
import { DevicePicker } from "@/components/device-picker"
import { HistoryTraceLine } from "@/components/history-trace-line"
import { HostNotReady } from "@/components/host-not-ready"
import { ProjectPicker } from "@/components/project-picker"
import { StartReviewButton } from "@/components/start-review-button"
import { SectionLabel } from "@/components/studio"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { chords } from "@/lib/chords"
import type { useReview } from "@/lib/use-review"

type Review = ReturnType<typeof useReview>

/**
 * Home, a launchpad: the Build, the device it runs on and the YouTrack
 * project it files into, then Start review. The Reviewer's last filed
 * session sits at the foot.
 */
export function HomeScreen({
  model,
  isDragging,
  onChooseBuild,
  onOpenHistory,
  onOpenCommands,
}: {
  readonly model: Review
  readonly isDragging: boolean
  readonly onChooseBuild: (file: File) => void
  readonly onOpenHistory: () => void
  readonly onOpenCommands: () => void
}) {
  const { review, host, projects, isBusy, errorMessage } = model
  const state = review.status === "loaded" ? review : undefined
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-panel/60 px-5">
        <span className="text-[13.5px] font-medium">New review</span>
        <span className="text-[12.5px] text-text-3">
          Build · device · project
        </span>
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          className="text-text-2"
          aria-label="Commands"
          title="Commands"
          onClick={onOpenCommands}
        >
          <CommandIcon />
          <Kbd>{chords.commands.label}</Kbd>
        </Button>
      </header>
      <div className="min-h-0 flex-1 thin-scroll overflow-y-auto canvas-dots">
        <div className="mx-auto flex w-full max-w-[880px] flex-col gap-6 px-8 py-12">
          <div>
            <h1 className="text-[22px] font-semibold tracking-[-0.02em]">
              Start a review
            </h1>
            <p className="mt-1 text-[13px] text-text-2">
              Load a Build, pick a device and a YouTrack project. The device
              runs on the Device Host and streams here.
            </p>
          </div>
          {review.status === "failed" && (
            <p role="alert" className="text-[13px] text-red select-text">
              {review.error}
            </p>
          )}
          <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-4">
            <BuildDropZone
              build={state?.build}
              isDragging={isDragging}
              disabled={isBusy || state === undefined}
              onChoose={onChooseBuild}
            />
            <div className="flex flex-col gap-4">
              <section className="flex flex-col gap-3 rounded-[14px] p-4 studio-card">
                <SectionLabel>Device</SectionLabel>
                {host.status === "notReady" ? (
                  <HostNotReady
                    reason={host.reason}
                    disabled={isBusy}
                    onCheckAgain={model.checkHostAgain}
                  />
                ) : (
                  <DevicePicker
                    variant="field"
                    devices={model.devices}
                    recentDeviceUDIDs={model.recentDeviceUDIDs}
                    selected={model.selectedDevice}
                    onSelect={model.selectDevice}
                    disabled={isBusy || host.status === "loading"}
                    androidProblem={model.androidProblem}
                  />
                )}
              </section>
              <section className="flex flex-col gap-3 rounded-[14px] p-4 studio-card">
                <SectionLabel>YouTrack project</SectionLabel>
                {projects.status === "failed" ? (
                  <p className="text-[12.5px] text-text-2">{projects.error}</p>
                ) : (
                  <ProjectPicker
                    projects={
                      projects.status === "loaded" ? projects.projects : []
                    }
                    selectedID={model.selectedProjectID}
                    onSelect={model.setSelectedProjectID}
                  />
                )}
              </section>
              <div className="flex flex-col gap-2">
                <StartReviewButton
                  size="lg"
                  title={model.startTitle}
                  missing={model.missingForStart}
                  onStart={model.startReview}
                />
                <p className="text-center text-[11.5px] text-text-3">
                  Boots the device, installs the Build and opens the review.
                </p>
              </div>
            </div>
          </div>
          {errorMessage !== undefined && (
            <p role="alert" className="text-[13px] text-red select-text">
              {errorMessage}
            </p>
          )}
          {model.trace !== undefined && (
            <HistoryTraceLine
              trace={model.trace}
              onOpenHistory={onOpenHistory}
            />
          )}
        </div>
      </div>
    </div>
  )
}
