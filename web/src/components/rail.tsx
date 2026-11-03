import type { YouTrackUser } from "@nitpick/core"
import {
  CommandIcon,
  HistoryIcon,
  KeyboardIcon,
  MessageSquareWarningIcon,
  ScanSearchIcon,
} from "lucide-react"
import { cn } from "cn"
import { LogoMark, Tip } from "@/components/studio"
import { UserMenu } from "@/components/user-menu"
import { chords } from "@/lib/chords"

/**
 * The slim rail down the page's left edge: the review, History, Send
 * feedback, then ⌘K, the shortcuts and the account. The review's dot says
 * a session is open: red while the Build runs, amber while paused.
 */
export function Rail({
  reviewer,
  page,
  session,
  onReview,
  onHistory,
  onSendFeedback,
  onCommands,
  onShortcuts,
  onSignOut,
}: {
  readonly reviewer: YouTrackUser
  readonly page: "review" | "history"
  /** Whether a session is open, and whether its Build runs now. */
  readonly session: "none" | "live" | "paused"
  readonly onReview: () => void
  readonly onHistory: () => void
  readonly onSendFeedback: () => void
  readonly onCommands: () => void
  readonly onShortcuts: () => void
  readonly onSignOut: () => void
}) {
  return (
    <nav
      aria-label="nitpick"
      className="relative z-20 flex w-[52px] shrink-0 flex-col items-center gap-1 bg-rail py-2.5 shadow-[inset_-1px_0_0_var(--line)]"
    >
      <Tip label="nitpick" side="right">
        <button
          type="button"
          aria-label="nitpick home"
          onClick={onReview}
          className="mb-3 rounded-[9px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <LogoMark size={30} />
        </button>
      </Tip>
      <RailButton
        label={session === "none" ? "New review" : "Review in progress"}
        active={page === "review"}
        onClick={onReview}
      >
        <ScanSearchIcon />
        {session !== "none" && (
          <span
            className={cn(
              "absolute top-1.5 right-1.5 size-[7px] rounded-full ring-2 ring-rail",
              session === "live" ? "bg-red" : "bg-amber"
            )}
          />
        )}
      </RailButton>
      <RailButton
        label="History"
        active={page === "history"}
        onClick={onHistory}
      >
        <HistoryIcon />
      </RailButton>
      <RailButton label="Send feedback" onClick={onSendFeedback}>
        <MessageSquareWarningIcon />
      </RailButton>
      <span className="flex-1" />
      <RailButton
        label="Commands"
        chord={chords.commands.label}
        onClick={onCommands}
      >
        <CommandIcon />
      </RailButton>
      <RailButton label="Keyboard shortcuts" chord="?" onClick={onShortcuts}>
        <KeyboardIcon />
      </RailButton>
      <UserMenu
        reviewer={reviewer}
        onSendFeedback={onSendFeedback}
        onShowShortcuts={onShortcuts}
        onSignOut={onSignOut}
      />
    </nav>
  )
}

function RailButton({
  label,
  chord,
  active = false,
  onClick,
  children,
}: {
  readonly label: string
  readonly chord?: string
  readonly active?: boolean
  readonly onClick: () => void
  readonly children: React.ReactNode
}) {
  return (
    <Tip label={label} chord={chord} side="right">
      <button
        type="button"
        aria-label={label}
        aria-current={active ? "page" : undefined}
        onClick={onClick}
        className={cn(
          "relative flex size-9 items-center justify-center rounded-[9px] outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-[18px] [&_svg]:stroke-[1.75]",
          active
            ? "bg-white/[0.09] text-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.06)]"
            : "text-text-3 hover:bg-white/[0.05] hover:text-foreground"
        )}
      >
        {children}
      </button>
    </Tip>
  )
}
