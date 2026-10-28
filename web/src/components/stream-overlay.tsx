import type { SimulatorDevice } from "@nitpick/server/api"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import type { DeviceStreamStatus } from "@/lib/device-stream"

export type ShownStatus = Exclude<DeviceStreamStatus, { kind: "unauthorized" }>

/** Covers the stream until its first frame, or when it failed. */
export function StreamOverlay({
  status,
  device,
  onReconnect,
}: {
  readonly status: ShownStatus
  readonly device: SimulatorDevice
  readonly onReconnect: () => void
}) {
  if (status.kind === "streaming") return null
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 p-4 text-center text-sm text-white">
      {status.kind === "connecting" ? (
        <>
          <Spinner />
          Connecting to {device.name}…
        </>
      ) : (
        <>
          <p role="alert" className="select-text">
            {status.message}
          </p>
          <Button size="sm" variant="secondary" onClick={onReconnect}>
            Reconnect
          </Button>
        </>
      )}
    </div>
  )
}
