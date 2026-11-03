import type { ComponentType } from "react"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command"
import { Kbd } from "@/components/ui/kbd"

/** One thing ⌘K can do, from wherever the Reviewer is. */
export interface PaletteCommand {
  readonly id: string
  readonly group: string
  readonly label: string
  readonly icon?: ComponentType<{ className?: string }>
  /** The chord that does it without the palette. */
  readonly keys?: string
  /** A second line, e.g. why it can't run now. */
  readonly hint?: string
  readonly disabled?: boolean
  readonly run: () => void
}

/**
 * ⌘K: every command the page offers right now, searchable. A command runs
 * once the palette has closed, so focus lands where the command sends it.
 */
export function CommandPalette({
  open,
  onOpenChange,
  commands,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly commands: ReadonlyArray<PaletteCommand>
}) {
  const groups = [...new Set(commands.map((command) => command.group))]
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Commands"
      description="Search for a command to run"
      className="w-[560px] max-w-[calc(100vw-2rem)] sm:max-w-[560px]"
    >
      <Command loop>
        <CommandInput placeholder="Type a command or search…" />
        <CommandList className="max-h-[min(60svh,420px)] thin-scroll">
          <CommandEmpty>No command matches.</CommandEmpty>
          {groups.map((group) => (
            <CommandGroup key={group} heading={group}>
              {commands
                .filter((command) => command.group === group)
                .map(({ id, label, icon: Icon, keys, hint, disabled, run }) => (
                  <CommandItem
                    key={id}
                    value={id}
                    keywords={[label, group]}
                    disabled={disabled}
                    onSelect={() => {
                      onOpenChange(false)
                      run()
                    }}
                    className="h-9"
                  >
                    {Icon !== undefined && <Icon className="text-text-2" />}
                    <span className="truncate">{label}</span>
                    {hint !== undefined && (
                      <span className="truncate text-[12px] text-text-3">
                        {hint}
                      </span>
                    )}
                    {keys !== undefined && keys !== "" && (
                      <CommandShortcut>
                        <Kbd>{keys}</Kbd>
                      </CommandShortcut>
                    )}
                  </CommandItem>
                ))}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
