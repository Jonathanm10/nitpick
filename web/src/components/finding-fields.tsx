import { useState } from "react"
import {
  filedIssueOf,
  findingTypes,
  isEditable,
  trimWhitespaceAndNewlines,
  type FindingType,
  type ProjectSchema,
  type TrayItem,
} from "@nitpick/core"
import type { FindingPatch, SessionSummary } from "@nitpick/server/api"
import { ArrowUpRightIcon } from "lucide-react"
import { cn } from "cn"
import { AssigneePicker } from "@/components/assignee-picker"
import { DesignSnapshotsSection } from "@/components/design-snapshots-section"
import { InspectorSection, ProjectKey } from "@/components/studio"
import { Input } from "@/components/ui/input"
import { Kbd } from "@/components/ui/kbd"
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

/** Red for a Bug, violet for an Improvement, wherever a Type shows. */
export const typeDotClass: Record<FindingType, string> = {
  bug: "bg-red",
  improvement: "bg-violet",
}

/** Base UI's Select has no empty value, so "No priority" gets its own. */
const noPriority = "no-priority"

/**
 * The open Finding in the inspector: its position and Type, then Summary
 * and Description, the properties (Type always, ADR-0008; Priority and
 * Assignee when the project's schema has them), its own Design Reference,
 * its Design Snapshots and the Device Context its capture stamped. Frozen
 * once filing began, it reads only. Keyed by the Finding, so typed state
 * starts over on every row.
 */
export function FindingInspector({
  item,
  session,
  schema,
  disabled,
  review,
  onReturn,
}: {
  readonly item: TrayItem
  readonly session: SessionSummary
  readonly schema: ProjectSchema
  readonly disabled: boolean
  readonly review: ReturnType<typeof useReview>
  /** Return in Summary: back to the live device. */
  readonly onReturn: () => void
}) {
  const { finding } = item
  const position = session.tray.indexOf(item) + 1
  return (
    <>
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-4 text-[13px]">
        <span className="font-mono text-[12px] text-text-3">
          {position}/{session.tray.length}
        </span>
        <span className="font-medium">Finding</span>
        <span className="flex items-center gap-1.5 text-[12px] text-text-2">
          <span
            className={cn(
              "size-[7px] rounded-full",
              typeDotClass[finding.type]
            )}
          />
          {typeLabels[finding.type]}
        </span>
        <span className="flex-1" />
        <FilingState item={item} />
      </div>
      {isEditable(item) ? (
        <FindingFields
          item={item}
          session={session}
          schema={schema}
          disabled={disabled}
          review={review}
          onReturn={onReturn}
        />
      ) : (
        <InspectorSection label="Summary">
          <p className="text-[13px] select-text">
            {trimWhitespaceAndNewlines(finding.summary) || "Untitled Finding"}
          </p>
          {finding.description.trim() !== "" && (
            <p className="text-[12.5px] whitespace-pre-wrap text-text-2 select-text">
              {finding.description}
            </p>
          )}
        </InspectorSection>
      )}
      <InspectorSection label="Device Context" aside="stamped at capture">
        <dl className="grid grid-cols-[6rem_1fr] gap-y-1.5 font-mono text-[11.5px]">
          <dt className="text-text-3">Device</dt>
          <dd>{finding.deviceContext.deviceModel}</dd>
          <dt className="text-text-3">OS</dt>
          <dd>{finding.deviceContext.osName}</dd>
          <dt className="text-text-3">Accessibility</dt>
          <dd className="text-text-2">
            {finding.deviceContext.accessibilitySettings.length === 0
              ? "Defaults"
              : finding.deviceContext.accessibilitySettings.join(", ")}
          </dd>
        </dl>
      </InspectorSection>
    </>
  )
}

/** The header's right end: the Issue once filed, or that filing began. */
function FilingState({ item }: { readonly item: TrayItem }) {
  const filed = filedIssueOf(item)
  if (filed !== undefined) {
    return (
      <a
        href={filed.url}
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-1 font-mono text-[12px] text-green hover:underline"
      >
        {filed.idReadable}
        <ArrowUpRightIcon className="size-3" />
      </a>
    )
  }
  if (!isEditable(item)) {
    return <span className="text-[12px] text-amber">Filing started</span>
  }
  return null
}

function FindingFields({
  item,
  session,
  schema,
  disabled,
  review,
  onReturn,
}: {
  readonly item: TrayItem
  readonly session: SessionSummary
  readonly schema: ProjectSchema
  readonly disabled: boolean
  readonly review: ReturnType<typeof useReview>
  readonly onReturn: () => void
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
  const needsSummary = trimWhitespaceAndNewlines(finding.summary) === ""

  return (
    <>
      <section className="flex flex-col gap-2 border-b px-4 py-3.5">
        <div className="flex h-5 items-center">
          <Label htmlFor="finding-summary" className="studio-label">
            Summary
          </Label>
          <span className="flex-1" />
          {needsSummary && (
            <span className="text-[11px] text-amber">Required</span>
          )}
        </div>
        <Input
          id="finding-summary"
          placeholder="What's off, in one line"
          value={finding.summary}
          disabled={disabled}
          aria-invalid={needsSummary || undefined}
          className="aria-invalid:border-amber/45 aria-invalid:ring-amber/15 dark:aria-invalid:border-amber/45 dark:aria-invalid:ring-amber/15"
          onChange={(event) => edit({ summary: event.target.value }, true)}
          // Return goes back to the Build: the device takes the stage and
          // focus. A chord with Return, such as File all's, still reaches
          // the page.
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.metaKey &&
              !event.ctrlKey &&
              !event.altKey &&
              !event.shiftKey
            ) {
              event.preventDefault()
              onReturn()
            }
          }}
        />
        <Label htmlFor="finding-description" className="sr-only">
          Description
        </Label>
        <Textarea
          id="finding-description"
          placeholder="Details, expected vs. actual… (optional)"
          value={finding.description}
          disabled={disabled}
          onChange={(event) => edit({ description: event.target.value }, true)}
          // Grows from three lines to six, then scrolls.
          className="max-h-[calc(6lh+1rem)] min-h-[calc(3lh+1rem)] resize-none"
        />
        <p className="flex items-center gap-1.5 text-[11.5px] text-text-3">
          <Kbd>⏎</Kbd> in Summary returns to the live device
        </p>
      </section>

      <section className="flex flex-col gap-2.5 border-b px-4 py-3.5">
        <h3 className="studio-label">Properties</h3>
        <PropertyRow label="Type">
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
              <ToggleGroupItem
                key={type}
                value={type}
                size="sm"
                className="flex-1 gap-1.5 px-2 text-[12px]"
              >
                <span
                  className={cn(
                    "size-[7px] rounded-full max-xl:hidden",
                    typeDotClass[type]
                  )}
                />
                {typeLabels[type]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </PropertyRow>

        {schema.priorities.length > 0 && (
          <PropertyRow label="Priority" htmlFor="finding-priority">
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
              <SelectTrigger id="finding-priority" size="sm" className="w-full">
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
          </PropertyRow>
        )}

        {schema.assignees.length > 0 && (
          <PropertyRow label="Assignee" htmlFor="finding-assignee">
            <AssigneePicker
              id="finding-assignee"
              assignees={schema.assignees}
              selected={finding.assignee}
              disabled={disabled}
              onSelect={(assignee) => edit({ assignee: assignee ?? null })}
            />
          </PropertyRow>
        )}

        <PropertyRow label="Project">
          <span className="flex h-7 items-center gap-2 text-[13px]">
            <ProjectKey project={session.project} />
            <span className="truncate">{session.project.name}</span>
          </span>
        </PropertyRow>
      </section>

      <section className="flex flex-col gap-2 border-b px-4 py-3.5">
        <Label htmlFor="finding-design-reference" className="studio-label">
          Design Reference
        </Label>
        <Input
          id="finding-design-reference"
          placeholder={
            session.designReference === undefined
              ? "Figma URL for this Finding only"
              : "Uses the session's Figma link"
          }
          title="A Figma URL for this Finding only. It replaces the session's Design Reference."
          className="font-mono text-[12px] placeholder:font-sans"
          value={designReference}
          disabled={disabled}
          onChange={(event) => {
            setDesignReference(event.target.value)
            const trimmed = trimWhitespaceAndNewlines(event.target.value)
            edit({ designReference: trimmed === "" ? null : trimmed }, true)
          }}
        />
        {session.designReference !== undefined &&
          designReference.trim() === "" && (
            <p className="truncate font-mono text-[11px] text-text-3">
              ↳ {session.designReference}
            </p>
          )}
      </section>

      <div className="border-b px-4 py-1.5">
        <DesignSnapshotsSection
          key={item.id}
          item={item}
          disabled={disabled}
          review={review}
        />
      </div>
    </>
  )
}

function PropertyRow({
  label,
  htmlFor,
  children,
}: {
  readonly label: string
  readonly htmlFor?: string
  readonly children: React.ReactNode
}) {
  return (
    <div className="grid grid-cols-[4.75rem_minmax(0,1fr)] items-center gap-2">
      <Label
        htmlFor={htmlFor}
        className="text-[12.5px] font-normal text-text-2"
      >
        {label}
      </Label>
      {children}
    </div>
  )
}
