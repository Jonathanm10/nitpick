import { useState } from "react"
import {
  findingTypes,
  trimWhitespaceAndNewlines,
  type FindingType,
  type ProjectSchema,
  type TrayItem,
} from "@nitpick/core"
import type { FindingPatch } from "@nitpick/server/api"
import { DesignSnapshotsSection } from "@/components/design-snapshots-section"
import { AssigneePicker } from "@/components/assignee-picker"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { useReview } from "@/lib/use-review"

const typeLabels: Record<FindingType, string> = {
  bug: "Bug",
  improvement: "Improvement",
}

/** Base UI's Select has no empty value, so "No priority" gets its own. */
const noPriority = "no-priority"

/**
 * The selected Finding's fields, after ContentView.swift's composeSection:
 * Type always (ADR-0008), Priority and Assignee only when the project's
 * schema has them, then Summary, Description, the Finding's own Design
 * Reference and its Design Snapshots. Keyed by the Finding, so typed state
 * starts over on every row.
 */
export function FindingFields({
  item,
  schema,
  disabled,
  review,
}: {
  readonly item: TrayItem
  readonly schema: ProjectSchema
  readonly disabled: boolean
  readonly review: ReturnType<typeof useReview>
}) {
  const { finding } = item
  // The field shows what was typed; the Finding holds it trimmed, blank as
  // none (AppModel's designReference(from:)).
  const [designReference, setDesignReference] = useState(
    finding.designReference ?? ""
  )

  function edit(patch: FindingPatch, typing = false) {
    review.editFinding(item.id, patch, { typing })
  }

  const priorityItems = [
    { value: noPriority, label: "No priority" },
    ...schema.priorities.map(({ name }) => ({ value: name, label: name })),
  ]

  return (
    <div className="flex flex-col gap-4">
      <Field label="Type" htmlFor={undefined}>
        <ToggleGroup
          aria-label="Type"
          variant="outline"
          spacing={0}
          value={[finding.type]}
          onValueChange={(value) => {
            const [type] = value as FindingType[]
            if (type !== undefined) edit({ type })
          }}
          disabled={disabled}
          className="w-full"
        >
          {findingTypes.map((type) => (
            <ToggleGroupItem key={type} value={type} className="flex-1">
              {typeLabels[type]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Field>

      {schema.priorities.length > 0 && (
        <Field label="Priority" htmlFor="finding-priority">
          <Select
            items={priorityItems}
            value={finding.priority?.name ?? noPriority}
            onValueChange={(name) =>
              edit({
                priority:
                  name === null || name === noPriority ? null : { name },
              })
            }
            disabled={disabled}
          >
            <SelectTrigger id="finding-priority" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {priorityItems.map((priority) => (
                <SelectItem key={priority.value} value={priority.value}>
                  {priority.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}

      {schema.assignees.length > 0 && (
        <Field label="Assignee" htmlFor="finding-assignee">
          <AssigneePicker
            id="finding-assignee"
            assignees={schema.assignees}
            selected={finding.assignee}
            disabled={disabled}
            onSelect={(assignee) => edit({ assignee: assignee ?? null })}
          />
        </Field>
      )}

      <Field label="Summary *" htmlFor="finding-summary">
        <Input
          id="finding-summary"
          placeholder="Summary"
          value={finding.summary}
          disabled={disabled}
          onChange={(event) => edit({ summary: event.target.value }, true)}
          // Return goes back to the Build once the page shows the device
          // stream; until then it does nothing. A chord with Return, such
          // as File all's, still reaches the page.
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.metaKey &&
              !event.ctrlKey &&
              !event.altKey &&
              !event.shiftKey
            ) {
              event.preventDefault()
            }
          }}
        />
      </Field>

      <Field label="Description" htmlFor="finding-description">
        <Textarea
          id="finding-description"
          placeholder="Description"
          value={finding.description}
          disabled={disabled}
          onChange={(event) => edit({ description: event.target.value }, true)}
          // Grows from three lines to six, then scrolls.
          className="max-h-[calc(6lh+1rem)] min-h-[calc(3lh+1rem)] resize-none"
        />
      </Field>

      <Field label="Design Reference" htmlFor="finding-design-reference">
        <Input
          id="finding-design-reference"
          placeholder="Figma URL for this Finding only"
          title="A Figma URL for this Finding only. It replaces the session's Design Reference."
          value={designReference}
          disabled={disabled}
          onChange={(event) => {
            setDesignReference(event.target.value)
            const trimmed = trimWhitespaceAndNewlines(event.target.value)
            edit({ designReference: trimmed === "" ? null : trimmed }, true)
          }}
        />
      </Field>

      <DesignSnapshotsSection
        key={item.id}
        item={item}
        disabled={disabled}
        review={review}
      />
    </div>
  )
}

function Field({
  label,
  htmlFor,
  children,
}: {
  readonly label: string
  readonly htmlFor: string | undefined
  readonly children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label
        htmlFor={htmlFor}
        className="text-xs font-medium text-muted-foreground uppercase"
      >
        {label}
      </Label>
      {children}
    </div>
  )
}
