import type { YouTrackUser } from "@nitpick/core"
import { CircleUserIcon, LogOutIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

/** Who is signed in, nitpick's version, and Sign out. */
export function UserMenu({
  reviewer,
  onSignOut,
}: {
  readonly reviewer: YouTrackUser
  readonly onSignOut: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="sm" />}>
        <CircleUserIcon />
        {reviewer.fullName}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-sm font-normal text-foreground">
            Signed in as {reviewer.fullName} ({reviewer.login})
          </DropdownMenuLabel>
          <DropdownMenuLabel className="font-normal">
            nitpick {__NITPICK_VERSION__}
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onSignOut}>
          <LogOutIcon />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
