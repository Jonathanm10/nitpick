import type { ReactNode } from "react"
import { formatPoints, type LayoutElement } from "@nitpick/core"
import { RefreshCwIcon, SquareDashedMousePointerIcon } from "lucide-react"
import { inspectColors } from "@/components/inspect-overlay"
import { InspectorSection, Tip } from "@/components/studio"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { chords } from "@/lib/chords"
import type { Inspect } from "@/lib/use-inspect"

/**
 * The inspector while Inspect is on: the selected element's layout values,
 * or the hovered one's while nothing is selected. Every value is text the
 * Reviewer can select and copy.
 */
export function InspectPanel({ inspect }: { readonly inspect: Inspect }) {
  const { reading, snapshot, selected, hovered } = inspect
  const element = selected ?? hovered
  return (
    <>
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-4 text-[13px]">
        <SquareDashedMousePointerIcon
          className="size-4"
          style={{ color: inspectColors.outline }}
        />
        <span className="font-medium">Inspect</span>
        <span className="flex-1" />
        <Tip label="Read the layout again" chord={chords.readLayoutAgain.label}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Read the layout again"
            className="text-text-2"
            disabled={reading?.status === "reading"}
            onClick={inspect.refresh}
          >
            <RefreshCwIcon />
          </Button>
        </Tip>
        <Tip label="Leave Inspect" chord="Esc">
          <Button
            variant="ghost"
            size="sm"
            className="text-text-2"
            onClick={inspect.leave}
          >
            Done
          </Button>
        </Tip>
      </div>
      {reading?.status === "reading" && (
        <InspectorSection label="Layout">
          <p className="flex items-center gap-2 text-[13px]">
            <Spinner className="size-3.5 text-text-2" />
            Reading the Build&rsquo;s layout…
          </p>
          <p className="text-[11.5px] text-text-3">
            The first read after a launch can take a few seconds.
          </p>
        </InspectorSection>
      )}
      {(reading?.status === "unavailable" || reading?.status === "failed") && (
        <InspectorSection label="Layout">
          <p className="text-[12.5px] text-text-2 select-text">
            {reading.status === "unavailable"
              ? reading.reason
              : reading.message}
          </p>
        </InspectorSection>
      )}
      {snapshot !== undefined && element === undefined && (
        <InspectorSection
          label="Layout"
          aside={`${snapshot.elements.length} elements`}
        >
          <p className="text-[12.5px] text-text-2">
            Hover an element on the device to read its layout, and click it to
            keep it selected. With one selected, hover another to measure the
            distance between them.
          </p>
          <p className="text-[11.5px] text-text-3">
            {reading?.status === "ready" &&
              `Read in ${formatSeconds(reading.duration)}. `}
            It shows the screen as it was then: once the app changes, read it
            again with {chords.readLayoutAgain.label}.
          </p>
        </InspectorSection>
      )}
      {element !== undefined && (
        <ElementValues
          element={element}
          state={element === selected ? "Selected" : "Hovered"}
        />
      )}
    </>
  )
}

function formatSeconds(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)} s`
}

/** iOS's names for its font weights, by their CSS weight. */
const weightNames: Readonly<Record<number, string>> = {
  100: "Ultralight",
  200: "Thin",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "Semibold",
  700: "Bold",
  800: "Heavy",
  900: "Black",
}

function ElementValues({
  element,
  state,
}: {
  readonly element: LayoutElement
  readonly state: "Selected" | "Hovered"
}) {
  const { frame, padding, spacing, gridSpacing, text, properties } = element
  const pt = formatPoints
  return (
    <>
      <InspectorSection label={state}>
        <p className="font-mono text-[13px] font-medium select-text">
          {element.name}
        </p>
        {properties !== undefined && (
          <Values>
            {Object.entries(properties).map(([name, value]) => (
              <Value key={name} label={name}>
                {value}
              </Value>
            ))}
          </Values>
        )}
      </InspectorSection>
      <InspectorSection label="Position and size" aside="points">
        <Values>
          <Value label="X">{pt(frame.x)}</Value>
          <Value label="Y">{pt(frame.y)}</Value>
          <Value label="Width">{pt(frame.width)}</Value>
          <Value label="Height">{pt(frame.height)}</Value>
        </Values>
      </InspectorSection>
      {padding !== undefined && (
        <InspectorSection label="Padding">
          <Values>
            <Value label="Top">{pt(padding.top)}</Value>
            <Value label="Leading">{pt(padding.leading)}</Value>
            <Value label="Bottom">{pt(padding.bottom)}</Value>
            <Value label="Trailing">{pt(padding.trailing)}</Value>
          </Values>
        </InspectorSection>
      )}
      {(spacing !== undefined || gridSpacing !== undefined) && (
        <InspectorSection label="Spacing">
          <Values>
            {spacing !== undefined && (
              <Value
                label={spacing.axis === "vertical" ? "Vertical" : "Horizontal"}
              >
                {pt(spacing.value)}
              </Value>
            )}
            {gridSpacing !== undefined && (
              <>
                <Value label="Columns">{pt(gridSpacing.horizontal)}</Value>
                <Value label="Rows">{pt(gridSpacing.vertical)}</Value>
              </>
            )}
          </Values>
        </InspectorSection>
      )}
      {text !== undefined && (
        <InspectorSection label="Text">
          <p className="rounded-md bg-white/[0.04] px-2 py-1.5 text-[12.5px] break-words whitespace-pre-wrap select-text">
            {text.content}
          </p>
          <Values>
            <Value label="Font">{text.font}</Value>
            <Value label="Family">{text.family}</Value>
            <Value label="Size">{pt(text.size)}</Value>
            {text.weight !== undefined && (
              <Value label="Weight">
                {text.weight} {weightNames[text.weight]}
              </Value>
            )}
            <Value label="Tracking">{pt(text.tracking ?? 0)}</Value>
            {text.lineHeight !== undefined && (
              <Value label="Line height">{pt(text.lineHeight)}</Value>
            )}
            {text.color !== undefined && (
              <Value label="Colour" swatch={text.color}>
                {text.color}
              </Value>
            )}
          </Values>
        </InspectorSection>
      )}
      {(element.fill !== undefined ||
        element.cornerRadius !== undefined ||
        element.image !== undefined) && (
        <InspectorSection label="Appearance">
          <Values>
            {element.fill !== undefined && (
              <Value label="Fill" swatch={element.fill}>
                {element.fill}
              </Value>
            )}
            {element.cornerRadius !== undefined && (
              <Value label="Corner radius">{pt(element.cornerRadius)}</Value>
            )}
            {element.image !== undefined && (
              <Value label="Image">{element.image}</Value>
            )}
          </Values>
        </InspectorSection>
      )}
    </>
  )
}

function Values({ children }: { readonly children: ReactNode }) {
  return (
    <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-y-1.5 font-mono text-[11.5px]">
      {children}
    </dl>
  )
}

/** One value; a colour written as hex gets its swatch. */
function Value({
  label,
  swatch,
  children,
}: {
  readonly label: string
  readonly swatch?: string
  readonly children: ReactNode
}) {
  return (
    <>
      <dt className="text-text-3">{label}</dt>
      <dd className="flex min-w-0 items-center gap-2 break-all select-text">
        {swatch?.startsWith("#") && (
          <span
            aria-hidden
            className="size-3 shrink-0 rounded-[3px] ring-1 ring-white/25"
            style={{ background: swatch }}
          />
        )}
        {children}
      </dd>
    </>
  )
}
