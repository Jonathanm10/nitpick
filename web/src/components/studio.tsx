// Studio's small building blocks: the mark, chord tooltips, avatars, the
// project key and the platform tag. Layout stays with each page.
import type { ReactElement, ReactNode } from "react"
import type { YouTrackProject, YouTrackUser } from "@nitpick/core"
import type { SimulatorDevice } from "@nitpick/server/api"
import { cn } from "cn"
import { Kbd } from "@/components/ui/kbd"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/** The app icon: a loupe over a pixel grid, one pixel off. */
export function LogoMark({
  size = 28,
  className,
}: {
  readonly size?: number
  readonly className?: string
}) {
  return (
    <img
      src="/icon.svg"
      alt=""
      width={size}
      height={size}
      draggable={false}
      // The squircle fills 824 of the artwork's 1024 px.
      className={cn("scale-[1.24]", className)}
    />
  )
}

/** A tooltip naming a control, with its chord when it has one. */
export function Tip({
  label,
  chord,
  side = "bottom",
  children,
}: {
  readonly label: ReactNode
  readonly chord?: string
  readonly side?: "top" | "bottom" | "left" | "right"
  readonly children: ReactElement
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side={side}>
        {label}
        {chord !== undefined && chord !== "" && (
          <Kbd className="ml-1">{chord}</Kbd>
        )}
      </TooltipContent>
    </Tooltip>
  )
}

/** Two initials on a colour picked from the login, so a person keeps theirs. */
export function Avatar({
  user,
  size = 22,
  className,
}: {
  readonly user: YouTrackUser
  readonly size?: number
  readonly className?: string
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white shadow-[inset_0_0_0_1px_rgb(255_255_255/0.18)]",
        className
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.4),
        background: `linear-gradient(160deg, oklch(0.72 0.13 ${hue(user.login)}), oklch(0.55 0.15 ${hue(user.login)}))`,
      }}
    >
      {initials(user.fullName || user.login)}
    </span>
  )
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/)
  const letters =
    words.length > 1 ? words[0][0] + words.at(-1)![0] : name.slice(0, 2)
  return letters.toLocaleUpperCase()
}

function hue(text: string): number {
  let sum = 0
  for (const char of text) sum = (sum * 31 + char.charCodeAt(0)) % 360
  return sum
}

/** The project's key, e.g. JW, as a small tinted badge. */
export function ProjectKey({
  project,
  className,
}: {
  readonly project: YouTrackProject
  readonly className?: string
}) {
  const h = hue(project.shortName)
  return (
    <span
      className={cn(
        "inline-flex h-[18px] shrink-0 items-center rounded-[4px] px-1.5 font-mono text-[10.5px] font-semibold",
        className
      )}
      style={{
        color: `oklch(0.82 0.1 ${h})`,
        background: `oklch(0.6 0.12 ${h} / 0.14)`,
        boxShadow: `inset 0 0 0 1px oklch(0.7 0.1 ${h} / 0.24)`,
      }}
    >
      {project.shortName}
    </span>
  )
}

/** iOS or AND, before a device's name. */
export function PlatformTag({
  device,
  className,
}: {
  readonly device: Pick<SimulatorDevice, "platform">
  readonly className?: string
}) {
  return (
    <span
      className={cn(
        "inline-flex h-4 shrink-0 items-center rounded-[3px] px-1 font-mono text-[9.5px] font-medium tracking-wide text-text-2 ring-1 ring-white/10",
        className
      )}
    >
      {device.platform === "android" ? "AND" : "iOS"}
    </span>
  )
}

/** A small-caps section heading with an optional note on the right. */
export function SectionLabel({
  children,
  aside,
  className,
}: {
  readonly children: ReactNode
  readonly aside?: ReactNode
  readonly className?: string
}) {
  return (
    <div className={cn("flex h-5 items-center gap-2", className)}>
      <h3 className="studio-label">{children}</h3>
      <span className="flex-1" />
      {aside !== undefined && (
        <span className="text-[11px] text-text-3">{aside}</span>
      )}
    </div>
  )
}

/** One of the inspector's sections, under a hairline. */
export function InspectorSection({
  label,
  aside,
  children,
}: {
  readonly label: string
  readonly aside?: React.ReactNode
  readonly children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-2 border-b px-4 py-3.5">
      <SectionLabel aside={aside}>{label}</SectionLabel>
      {children}
    </section>
  )
}
