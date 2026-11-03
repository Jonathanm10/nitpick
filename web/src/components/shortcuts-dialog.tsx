import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Kbd } from "@/components/ui/kbd"
import { shortcutGroups } from "@/lib/chords"

/** The page's chords, as this browser's platform spells them. */
export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Reload, new tab and the browser&rsquo;s own History keep their usual
            keys.
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-1 flex max-h-[62svh] thin-scroll flex-col gap-4 overflow-y-auto px-1">
          {shortcutGroups.map((group) => (
            <section key={group.title} className="flex flex-col gap-1">
              <h3 className="pb-1 studio-label">{group.title}</h3>
              <dl className="flex flex-col">
                {group.shortcuts.map((shortcut) => (
                  <div
                    key={shortcut.action}
                    className="flex h-7 items-center justify-between gap-4 border-b border-line text-[13px] last:border-0"
                  >
                    <dt className="text-text-2">{shortcut.action}</dt>
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
