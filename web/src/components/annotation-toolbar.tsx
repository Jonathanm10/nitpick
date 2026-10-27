import {
  annotationColors,
  annotationCSSColor,
  type AnnotationColor,
} from "@nitpick/core"
import {
  ArrowUpRightIcon,
  MousePointer2Icon,
  PenLineIcon,
  Redo2Icon,
  SquareIcon,
  TypeIcon,
  Undo2Icon,
} from "lucide-react"
import type { ComponentType } from "react"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { chords } from "@/lib/chords"
import type { AnnotationTool, Editor } from "@/lib/use-editor"

export const annotationTools: ReadonlyArray<{
  readonly tool: AnnotationTool
  readonly title: string
  /** The letter that picks it while no text field has focus. */
  readonly key: string
  readonly purpose: string
  readonly icon: ComponentType<{ className?: string }>
}> = [
  {
    tool: "select",
    title: "Select",
    key: "V",
    purpose: "click a mark to select it",
    icon: MousePointer2Icon,
  },
  {
    tool: "pen",
    title: "Pen",
    key: "P",
    purpose: "draw freehand",
    icon: PenLineIcon,
  },
  {
    tool: "arrow",
    title: "Arrow",
    key: "A",
    purpose: "point at an element",
    icon: ArrowUpRightIcon,
  },
  {
    tool: "rectangle",
    title: "Rectangle",
    key: "R",
    purpose: "mark a region",
    icon: SquareIcon,
  },
  {
    tool: "label",
    title: "Text label",
    key: "T",
    purpose: "click to place a note",
    icon: TypeIcon,
  },
]

function colorName(color: AnnotationColor): string {
  return color[0].toUpperCase() + color.slice(1)
}

/**
 * The annotation toolbar, after Sources/Nitpick/AnnotationToolbar.swift:
 * tools, the six colours, Undo and Redo. A click always acts on the
 * Annotations; the chords leave a focused text field its own undo.
 */
export function AnnotationToolbar({ editor }: { readonly editor: Editor }) {
  const disabled = !editor.canEdit
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-2 py-1.5 shadow-xs">
      <ToggleGroup
        aria-label="Tool"
        value={[editor.tool]}
        onValueChange={(value) => {
          const [next] = value as AnnotationTool[]
          if (next !== undefined) editor.setTool(next)
        }}
        spacing={0}
        disabled={disabled}
      >
        {annotationTools.map(({ tool, title, key, purpose, icon: Icon }) => (
          <Tooltip key={tool}>
            <TooltipTrigger
              render={
                <ToggleGroupItem
                  value={tool}
                  size="sm"
                  aria-label={`${title} (${key})`}
                />
              }
            >
              <Icon />
            </TooltipTrigger>
            <TooltipContent>
              {title} ({key}) — {purpose}
            </TooltipContent>
          </Tooltip>
        ))}
      </ToggleGroup>
      <div role="radiogroup" aria-label="Colour" className="flex gap-1.5">
        {annotationColors.map((color) => {
          const selected = editor.color === color
          return (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={colorName(color)}
              title={colorName(color)}
              disabled={disabled}
              onClick={() => editor.setColor(color)}
              className="size-4.5 rounded-full ring-foreground/20 outline-offset-2 transition-shadow not-aria-checked:ring-1 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 aria-checked:ring-2 aria-checked:ring-foreground/90"
              style={{ backgroundColor: annotationCSSColor(color) }}
            />
          )
        })}
      </div>
      <Separator orientation="vertical" className="h-5" />
      <span className="flex-1" />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Undo Annotation"
              disabled={!editor.canUndo}
              onClick={editor.undo}
            />
          }
        >
          <Undo2Icon />
        </TooltipTrigger>
        <TooltipContent>Undo Annotation ({chords.undo.label})</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Redo Annotation"
              disabled={!editor.canRedo}
              onClick={editor.redo}
            />
          }
        >
          <Redo2Icon />
        </TooltipTrigger>
        <TooltipContent>Redo Annotation ({chords.redo.label})</TooltipContent>
      </Tooltip>
    </div>
  )
}
