import type { YouTrackUser } from "@nitpick/core"
import {
  KeyboardIcon,
  LogOutIcon,
  MessageSquareWarningIcon,
} from "lucide-react"
import { Avatar } from "@/components/studio"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

/** The rail's avatar: who is signed in, nitpick's version, and Sign out. */
export function UserMenu({
  reviewer,
  onSendFeedback,
  onShowShortcuts,
  onSignOut,
}: {
  readonly reviewer: YouTrackUser
  readonly onSendFeedback: () => void
  readonly onShowShortcuts: () => void
  readonly onSignOut: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Account, ${reviewer.fullName}`}
        className="mt-1.5 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Avatar user={reviewer} size={28} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="right"
        align="end"
        sideOffset={10}
        className="w-64"
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex items-center gap-2.5 py-2 font-normal">
            <Avatar user={reviewer} size={30} />
            <span className="min-w-0">
              <span className="block text-[11px] text-text-3">
                Signed in as
              </span>
              <span className="block truncate text-[13px] font-medium text-foreground">
                {reviewer.fullName}{" "}
                <span className="font-mono text-[11.5px] font-normal text-text-3">
                  ({reviewer.login})
                </span>
              </span>
            </span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onSendFeedback}>
          <MessageSquareWarningIcon />
          Send feedback…
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onShowShortcuts}>
          <KeyboardIcon />
          Keyboard shortcuts
          <DropdownMenuShortcut>?</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onSignOut}>
          <LogOutIcon />
          Sign out
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="font-mono text-[10.5px] font-normal text-text-3">
          nitpick {__NITPICK_VERSION__}
        </DropdownMenuLabel>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
