import { useState } from "react"
import { RecentDevices } from "@nitpick/core"
import type { SimulatorDevice } from "@nitpick/server/api"
import {
  ChevronDownIcon,
  ChevronsUpDownIcon,
  SmartphoneIcon,
} from "lucide-react"
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
  /**
   * `field` is home's control under the drop zone; `chip` is the Device
   * Context at the start of the session's top bar. Both open the same list.
   */
  readonly variant: "field" | "chip"
}

/**
 * The Device Host's devices in a searchable list, after
 * Sources/Nitpick/DeviceContextChip.swift: a Recent section of the devices
 * actually reviewed on, then All. Runtime-missing devices stay visible in All,
 * greyed out and unselectable, and never appear in Recent.
 */
export function DevicePicker({
  devices,
  recentDeviceUDIDs,
  selected,
  onSelect,
  disabled = false,
  variant,
}: DevicePickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const recent = new RecentDevices(recentDeviceUDIDs).resolved(devices)
  const hasMissingRuntime = devices.some((device) => !device.isRuntimeAvailable)

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
        {deviceLabel(device)}
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
            <Button variant="ghost" size="sm" className="gap-1.5" />
          ) : (
            <Button
              variant="outline"
              className="w-full max-w-80 justify-between font-normal"
            />
          )
        }
      >
        {variant === "chip" ? (
          <>
            <SmartphoneIcon className="text-muted-foreground" />
            <span className="font-medium">
              {selected?.name ?? "No device selected"}
            </span>
            <span className="text-muted-foreground">
              · {selected?.osName ?? "runtime unknown"}
            </span>
            <ChevronDownIcon className="text-muted-foreground" />
          </>
        ) : (
          <>
            <span
              className={selected === undefined ? "text-muted-foreground" : ""}
            >
              {selected === undefined
                ? "No device selected"
                : `${selected.name} — ${selected.osName}`}
            </span>
            <ChevronsUpDownIcon className="text-muted-foreground" />
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
          {hasMissingRuntime && (
            <p className="border-t px-3 py-2 text-xs text-muted-foreground">
              A greyed-out device needs its iOS runtime installed on the Device
              Host. Ask whoever runs the Device Host.
            </p>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** "Name — iOS x.y", marked when its runtime is missing. */
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
