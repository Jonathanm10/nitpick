import { useState } from "react"
import type { FindingAssignee } from "@nitpick/core"
import { ChevronsUpDownIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
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

/**
 * A searchable people-picker over the project's assignable users, after
 * Sources/Nitpick/AssigneePicker.swift. Unassigned is a first-class choice
 * and comes first.
 */
export function AssigneePicker({
  id,
  assignees,
  selected,
  disabled,
  onSelect,
}: {
  readonly id: string
  readonly assignees: ReadonlyArray<FindingAssignee>
  readonly selected: FindingAssignee | undefined
  readonly disabled: boolean
  readonly onSelect: (assignee: FindingAssignee | undefined) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const needle = query.trim().toLocaleLowerCase()
  const matches =
    needle === ""
      ? assignees
      : assignees.filter(
          (user) =>
            user.fullName.toLocaleLowerCase().includes(needle) ||
            user.login.toLocaleLowerCase().includes(needle)
        )

  function choose(assignee: FindingAssignee | undefined) {
    setQuery("")
    setOpen(false)
    onSelect(assignee)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        id={id}
        disabled={disabled}
        render={
          <Button
            variant="outline"
            className="w-full justify-between font-normal"
          />
        }
      >
        <span
          className={
            selected === undefined
              ? "truncate text-muted-foreground"
              : "truncate"
          }
        >
          {selected?.fullName ?? "Unassigned"}
        </span>
        <ChevronsUpDownIcon className="text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search people"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty>No one matches.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="unassigned"
                data-checked={selected === undefined}
                onSelect={() => choose(undefined)}
              >
                Unassigned
              </CommandItem>
              {matches.map((user) => (
                <CommandItem
                  key={user.login}
                  value={`user-${user.login}`}
                  data-checked={user.login === selected?.login}
                  onSelect={() => choose(user)}
                >
                  {user.fullName}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
