import type { YouTrackProject } from "@nitpick/core"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

/**
 * The YouTrack project the session files into, "Name (KEY)". Home shows it
 * only while no session is open: a session pinned its project at Start
 * review, and the session screen names it instead.
 */
export function ProjectPicker({
  projects,
  selectedID,
  onSelect,
}: {
  readonly projects: ReadonlyArray<YouTrackProject>
  readonly selectedID: string | undefined
  readonly onSelect: (id: string) => void
}) {
  const items = projects.map((project) => ({
    value: project.id,
    label: `${project.name} (${project.shortName})`,
  }))
  return (
    <Select
      items={items}
      value={selectedID ?? null}
      onValueChange={(id) => {
        if (id !== null) onSelect(id)
      }}
    >
      <SelectTrigger aria-label="Project" className="w-full max-w-80">
        <SelectValue placeholder="Pick a YouTrack project" />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
