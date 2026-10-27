import { KeyboardIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Kbd } from "@/components/ui/kbd"
import { shortcutGroups } from "@/lib/chords"

/** The page's chords, as this browser's platform spells them. */
export function ShortcutsDialog() {
  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts"
          />
        }
      >
        <KeyboardIcon />
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Reload, new tab and the browser&rsquo;s own History keep their usual
            keys.
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[60svh] flex-col gap-4 overflow-y-auto">
          {shortcutGroups.map((group) => (
            <section key={group.title} className="flex flex-col gap-1.5">
              <h3 className="text-xs font-medium text-muted-foreground">
                {group.title}
              </h3>
              <dl className="flex flex-col gap-1">
                {group.shortcuts.map((shortcut) => (
                  <div
                    key={shortcut.action}
                    className="flex items-center justify-between gap-4"
                  >
                    <dt>{shortcut.action}</dt>
                    <dd>
                      <Kbd>{shortcut.keys}</Kbd>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
