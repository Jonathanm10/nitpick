import { useEffect, useState } from "react"
import type {
  DevicesResponse,
  ErrorResponse,
  SimulatorDevice,
} from "@nitpick/server/api"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

type DeviceList =
  | { status: "loading" }
  | { status: "loaded"; devices: ReadonlyArray<SimulatorDevice> }
  | { status: "failed"; error: string }

export function App() {
  const [list, setList] = useState<DeviceList>({ status: "loading" })

  useEffect(() => {
    const controller = new AbortController()
    fetchDevices(controller.signal)
      .then(setList)
      .catch(() => {
        if (controller.signal.aborted) return
        setList({
          status: "failed",
          error: "The nitpick server could not be reached.",
        })
      })
    return () => controller.abort()
  }, [])

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-lg font-medium">nitpick</h1>
        <p className="text-sm text-muted-foreground">
          iOS simulators on the Device Host, newest OS first.
        </p>
      </header>
      {list.status === "loading" && (
        <p className="text-sm text-muted-foreground">Loading simulators…</p>
      )}
      {list.status === "failed" && (
        <p role="alert" className="text-sm text-destructive">
          {list.error}
        </p>
      )}
      {list.status === "loaded" && <DeviceTable devices={list.devices} />}
    </main>
  )
}

function DeviceTable({ devices }: { devices: ReadonlyArray<SimulatorDevice> }) {
  if (devices.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        This Device Host has no iOS simulators.
      </p>
    )
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>OS</TableHead>
          <TableHead>State</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {devices.map((device) => (
          <TableRow
            key={device.udid}
            className={
              device.isRuntimeAvailable ? undefined : "text-muted-foreground"
            }
          >
            <TableCell className="font-medium">{device.name}</TableCell>
            <TableCell>{device.osName}</TableCell>
            <TableCell>{stateLabel(device)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function stateLabel(device: SimulatorDevice): string {
  if (!device.isRuntimeAvailable) return "Runtime missing"
  return device.isBooted ? "Booted" : "Shut down"
}

async function fetchDevices(signal: AbortSignal): Promise<DeviceList> {
  const response = await fetch("/api/devices", { signal })
  if (!response.ok) {
    const body = (await response
      .json()
      .catch(() => null)) as ErrorResponse | null
    return {
      status: "failed",
      error: body?.error ?? `The server answered ${response.status}.`,
    }
  }
  const body = (await response.json()) as DevicesResponse
  return { status: "loaded", devices: body.devices }
}

export default App
