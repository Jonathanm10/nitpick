import { useState } from "react"
import { RecentDevices } from "@nitpick/core"
import type { SimulatorDevice } from "@nitpick/server/api"
import {
  ChevronDownIcon,
  ChevronsUpDownIcon,
  SmartphoneIcon,
} from "lucide-react"
import { cn } from "cn"
import { PlatformTag } from "@/components/studio"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

interface DevicePickerProps {
  readonly devices: ReadonlyArray<SimulatorDevice>
  readonly recentDeviceUDIDs: ReadonlyArray<string>
  readonly selected: SimulatorDevice | undefined
  readonly onSelect: (device: SimulatorDevice) => void
  readonly disabled?: boolean
  /** Why no Android emulator is listed, when the host can't run one. */
  readonly androidProblem?: string
  /**
   * `field` is home's control under the drop zone; `chip` is the Device
   * Context at the start of the session's top bar. Both open the same list.
   */
  readonly variant: "field" | "chip"
  /** The chip's status: the Build runs on the device now. */
  readonly isLive?: boolean
}

/**
 * The Device Host's devices in a searchable list, after
 * Sources/Nitpick/DeviceContextChip.swift: a Recent section of the devices
 * actually reviewed on, then All, each named with its OS, so iOS or Android. Runtime-missing devices stay visible in All,
 * greyed out and unselectable, and never appear in Recent.
 */
export function DevicePicker({
  devices,
  recentDeviceUDIDs,
  selected,
  onSelect,
  disabled = false,
  variant,
  androidProblem,
  isLive = false,
}: DevicePickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const recent = new RecentDevices(recentDeviceUDIDs).resolved(devices)
  const missing = devices.filter((device) => !device.isRuntimeAvailable)
  const missingSimulator = missing.some(
    (device) => device.platform !== "android"
  )
  const missingEmulator = missing.some(
    (device) => device.platform === "android"
  )

  function choose(device: SimulatorDevice) {
    setQuery("")
    setOpen(false)
    onSelect(device)
  }

  function rows(section: string, sectionDevices: SimulatorDevice[]) {
    return filtered(sectionDevices, query).map((device) => (
      <CommandItem
        key={device.udid}
        value={`${section}-${device.udid}`}
        disabled={!device.isRuntimeAvailable}
        data-checked={device.udid === selected?.udid}
        onSelect={() => choose(device)}
      >
        <PlatformTag device={device} />
        <span className="truncate">{deviceLabel(device)}</span>
      </CommandItem>
    ))
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        aria-label={
          variant === "chip"
            ? `Device Context, ${selected?.name ?? "no device selected"} — ${selected?.osName ?? "runtime unknown"}`
            : undefined
        }
        render={
          variant === "chip" ? (
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-2 rounded-[9px] bg-white/[0.03] px-2.5"
            />
          ) : (
            <Button
              variant="outline"
              className="h-9 w-full justify-between font-normal"
            />
          )
        }
      >
        {variant === "chip" ? (
          <>
            {selected === undefined ? (
              <SmartphoneIcon className="text-text-3" />
            ) : (
              <PlatformTag device={selected} />
            )}
            <span className="font-medium">
              {selected?.name ?? "No device selected"}
            </span>
            <span className="font-mono text-[11.5px] text-text-2">
              {selected?.osName ?? "runtime unknown"}
            </span>
            <span className="h-3.5 w-px bg-line-strong" />
            <span className="flex items-center gap-1.5 text-[12px]">
              {isLive ? (
                <span className="live-dot" />
              ) : (
                <span className="size-[7px] rounded-full bg-amber" />
              )}
              {isLive ? "Live" : "Paused"}
            </span>
            <ChevronDownIcon className="text-text-3" />
          </>
        ) : (
          <>
            <span
              className={cn(
                "flex min-w-0 items-center gap-2",
                selected === undefined && "text-text-3"
              )}
            >
              {selected !== undefined && <PlatformTag device={selected} />}
              <span className="truncate">
                {selected === undefined ? "No device selected" : selected.name}
              </span>
              {selected !== undefined && (
                <span className="font-mono text-[11.5px] text-text-2">
                  {selected.osName}
                </span>
              )}
            </span>
            <ChevronsUpDownIcon className="text-text-3" />
          </>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search devices"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {/* Recent stays while filtering whenever the Reviewer has
                recents; the filter only narrows its rows. */}
            {recent.length > 0 && (
              <CommandGroup heading="Recent">
                {rows("recent", recent)}
              </CommandGroup>
            )}
            <CommandGroup heading="All">
              {rows("all", [...devices])}
            </CommandGroup>
          </CommandList>
          {missingSimulator && (
            <p className="border-t px-3 py-2 text-xs text-muted-foreground">
              A greyed-out device needs its iOS runtime installed on the Device
              Host. Ask whoever runs the Device Host.
            </p>
          )}
          {missingEmulator && (
            <p className="border-t px-3 py-2 text-xs text-muted-foreground">
              A greyed-out emulator needs its Android system image installed on
              the Device Host. Ask whoever runs the Device Host.
            </p>
          )}
          {androidProblem !== undefined && (
            <p className="border-t px-3 py-2 text-xs text-muted-foreground">
              {androidProblem}
            </p>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** "Name — iOS x.y" or "Name — Android n", marked when its runtime is missing. */
function deviceLabel(device: SimulatorDevice): string {
  const label = `${device.name} — ${device.osName}`
  return device.isRuntimeAvailable ? label : `${label} (runtime missing)`
}

/**
 * Matches the device name or its OS, ignoring case, so "17 pro" and "26.4"
 * both narrow the list, as Swift's localizedCaseInsensitiveContains did.
 */
function filtered(
  devices: SimulatorDevice[],
  query: string
): SimulatorDevice[] {
  const needle = query.trim().toLocaleLowerCase()
  if (needle === "") return devices
  return devices.filter(
    (device) =>
      device.name.toLocaleLowerCase().includes(needle) ||
      device.osName.toLocaleLowerCase().includes(needle)
  )
}
