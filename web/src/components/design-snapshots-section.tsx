import { useEffect, useRef, useState, type DragEvent } from "react"
import type { DesignSnapshot, TrayItem } from "@nitpick/core"
import { ClipboardPasteIcon, PlusIcon, XIcon } from "lucide-react"
import { cn } from "cn"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { api } from "@/lib/api"
import { isTextEntry } from "@/lib/chords"
import type { useReview } from "@/lib/use-review"

/** A file to add, named as the Reviewer will see it. */
interface NamedImage {
  readonly data: Blob
  readonly name: string
}

/**
 * Some browsers prompt before a page reads the clipboard, and none let it
 * outside a secure context, such as plain HTTP on the office LAN. There the
 * Paste button goes, and ⌘V / Ctrl+V into the page still pastes.
 */
const canReadClipboard =
  typeof navigator.clipboard?.read === "function" && window.isSecureContext

/**
 * A Finding's Design Snapshots, after
 * Sources/Nitpick/DesignSnapshotsSection.swift: Add from a picker, Paste,
 * a drop on the section, thumbnails with a full-size preview, rename on
 * Return, Replace in place and Remove behind a confirmation. Every change
 * goes to the server, which checks the bytes and keeps the files.
 */
export function DesignSnapshotsSection({
  item,
  disabled,
  review,
}: {
  readonly item: TrayItem
  readonly disabled: boolean
  readonly review: ReturnType<typeof useReview>
}) {
  const snapshots = item.finding.designSnapshots
  const [errors, setErrors] = useState<string[]>([])
  const [pending, setPending] = useState(0)
  const [isDragging, setIsDragging] = useState(false)
  const [previewed, setPreviewed] = useState<DesignSnapshot>()
  const [pendingRemoval, setPendingRemoval] = useState<DesignSnapshot>()
  const fileInput = useRef<HTMLInputElement>(null)
  // The snapshot the next picked file replaces; undefined adds instead.
  const replacing = useRef<string>(undefined)
  const busy = disabled || pending > 0

  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    setPending((count) => count + 1)
    try {
      return await action()
    } finally {
      setPending((count) => count - 1)
    }
  }

  /** Adds each file in turn; every rejected one gets its own error line. */
  async function add(files: ReadonlyArray<NamedImage>) {
    if (busy || files.length === 0) return
    const failures: string[] = []
    await run(async () => {
      for (const file of files) {
        try {
          const { snapshot } = await api.addDesignSnapshot(
            item.id,
            file.data,
            file.name
          )
          review.setDesignSnapshots(item.id, (current) => [
            ...current,
            snapshot,
          ])
        } catch (error) {
          failures.push(`${file.name}: ${messageOf(error)}`)
        }
      }
    })
    setErrors(failures)
  }

  async function change(action: () => Promise<void>) {
    try {
      await run(action)
      setErrors([])
    } catch (error) {
      setErrors([messageOf(error)])
    }
  }

  function replaceWith(snapshotID: string, file: File) {
    void change(async () => {
      const { snapshot } = await api.replaceDesignSnapshot(
        item.id,
        snapshotID,
        file
      )
      review.setDesignSnapshots(item.id, (current) =>
        current.map((candidate) =>
          candidate.id === snapshot.id ? snapshot : candidate
        )
      )
    })
  }

  function rename(snapshotID: string, name: string) {
    void change(async () => {
      const { snapshot } = await api.renameDesignSnapshot(
        item.id,
        snapshotID,
        name
      )
      review.setDesignSnapshots(item.id, (current) =>
        current.map((candidate) =>
          candidate.id === snapshot.id ? snapshot : candidate
        )
      )
    })
  }

  function remove(snapshotID: string) {
    void change(async () => {
      await api.removeDesignSnapshot(item.id, snapshotID)
      review.setDesignSnapshots(item.id, (current) =>
        current.filter((candidate) => candidate.id !== snapshotID)
      )
    })
  }

  /** Clipboard images become "Pasted Design N", numbered after the rest. */
  function pasted(images: ReadonlyArray<Blob>): NamedImage[] {
    return images.map((data, index) => ({
      data,
      name: `Pasted Design ${snapshots.length + index + 1}.${data.type === "image/jpeg" ? "jpg" : "png"}`,
    }))
  }

  async function pasteFromClipboard() {
    try {
      const images: Blob[] = []
      for (const clipboardItem of await navigator.clipboard.read()) {
        const type = clipboardItem.types.find((candidate) =>
          ["image/png", "image/jpeg"].includes(candidate)
        )
        if (type !== undefined) images.push(await clipboardItem.getType(type))
      }
      if (images.length === 0) throw new Error()
      await add(pasted(images))
    } catch {
      setErrors(["The clipboard does not contain a readable image."])
    }
  }

  // ⌘V / Ctrl+V anywhere outside a text field pastes clipboard images
  // here, through the browser's paste event, which needs no permission.
  const addRef = useRef(add)
  const pastedRef = useRef(pasted)
  useEffect(() => {
    addRef.current = add
    pastedRef.current = pasted
  })
  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      if (isTextEntry(document.activeElement)) return
      const images = [...(event.clipboardData?.files ?? [])].filter((file) =>
        ["image/png", "image/jpeg"].includes(file.type)
      )
      if (images.length === 0) return
      event.preventDefault()
      void addRef.current(pastedRef.current(images))
    }
    document.addEventListener("paste", paste)
    return () => document.removeEventListener("paste", paste)
  }, [])

  // A drop here is a Design Snapshot, never a Build for the page.
  function dragOver(event: DragEvent) {
    if (!event.dataTransfer.types.includes("Files")) return
    event.preventDefault()
    event.stopPropagation()
    setIsDragging(true)
  }

  function drop(event: DragEvent) {
    if (!event.dataTransfer.types.includes("Files")) return
    event.preventDefault()
    event.stopPropagation()
    setIsDragging(false)
    void add(
      [...event.dataTransfer.files].map((file) => ({
        data: file,
        name: file.name,
      }))
    )
  }

  return (
    <section
      aria-label="Design Snapshots"
      onDragOver={dragOver}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setIsDragging(false)
      }}
      onDrop={drop}
      className={cn(
        "-mx-2 flex flex-col gap-2 rounded-lg border border-transparent p-2",
        isDragging && "border-dashed border-ring bg-muted/50"
      )}
    >
      <div className="flex items-center gap-1">
        <h3 className="text-xs font-medium text-muted-foreground uppercase">
          Design Snapshots
        </h3>
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="xs"
          disabled={busy}
          onClick={() => {
            replacing.current = undefined
            fileInput.current?.click()
          }}
        >
          <PlusIcon />
          Add
        </Button>
        {canReadClipboard && (
          <Button
            variant="ghost"
            size="xs"
            disabled={busy}
            onClick={() => void pasteFromClipboard()}
          >
            <ClipboardPasteIcon />
            Paste
          </Button>
        )}
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg"
        multiple
        hidden
        onChange={(event) => {
          const files = [...(event.target.files ?? [])]
          event.target.value = ""
          const target = replacing.current
          replacing.current = undefined
          if (target !== undefined) {
            if (files[0] !== undefined) replaceWith(target, files[0])
          } else {
            void add(files.map((file) => ({ data: file, name: file.name })))
          }
        }}
      />

      {snapshots.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Add a PNG from the design.
        </p>
      ) : (
        <ul className="flex gap-2 overflow-x-auto pb-1">
          {snapshots.map((snapshot) => (
            <SnapshotCard
              key={snapshot.id}
              itemID={item.id}
              snapshot={snapshot}
              disabled={busy}
              onPreview={() => setPreviewed(snapshot)}
              onRename={(name) => rename(snapshot.id, name)}
              onReplace={() => {
                replacing.current = snapshot.id
                if (fileInput.current !== null) {
                  fileInput.current.multiple = false
                  fileInput.current.click()
                  fileInput.current.multiple = true
                }
              }}
              onRemove={() => setPendingRemoval(snapshot)}
            />
          ))}
        </ul>
      )}
      {errors.length > 0 && (
        <p
          role="alert"
          className="text-xs whitespace-pre-line text-destructive select-text"
        >
          {errors.join("\n")}
        </p>
      )}

      <Dialog
        open={previewed !== undefined}
        onOpenChange={(open) => {
          if (!open) setPreviewed(undefined)
        }}
      >
        <DialogContent className="flex max-h-[90svh] flex-col sm:max-w-[min(90vw,64rem)]">
          <DialogHeader>
            <DialogTitle>{previewed?.name}</DialogTitle>
          </DialogHeader>
          {previewed !== undefined && (
            <img
              src={api.designSnapshotURL(item.id, previewed.dataVersion)}
              alt={previewed.name}
              className="min-h-0 flex-1 object-contain"
            />
          )}
          <div className="flex justify-end">
            <Button onClick={() => setPreviewed(undefined)}>Done</Button>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pendingRemoval !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingRemoval(undefined)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {pendingRemoval?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The image will no longer be filed with this Finding.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const snapshot = pendingRemoval
                setPendingRemoval(undefined)
                if (snapshot !== undefined) remove(snapshot.id)
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

function SnapshotCard({
  itemID,
  snapshot,
  disabled,
  onPreview,
  onRename,
  onReplace,
  onRemove,
}: {
  readonly itemID: string
  readonly snapshot: DesignSnapshot
  readonly disabled: boolean
  readonly onPreview: () => void
  readonly onRename: (name: string) => void
  readonly onReplace: () => void
  readonly onRemove: () => void
}) {
  // The typed name until Return saves it; a saved name replaces it.
  const [name, setName] = useState(snapshot.name)
  const [savedName, setSavedName] = useState(snapshot.name)
  if (savedName !== snapshot.name) {
    setSavedName(snapshot.name)
    setName(snapshot.name)
  }
  return (
    <li className="group/card flex w-26 shrink-0 flex-col gap-1">
      <div className="relative">
        <button
          type="button"
          onClick={onPreview}
          aria-label={`Design Snapshot ${snapshot.name}`}
          title="Open a larger preview"
          className="block overflow-hidden rounded-md ring-1 ring-foreground/10 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <img
            src={api.designSnapshotURL(itemID, snapshot.dataVersion)}
            alt=""
            className="h-18 w-26 object-cover"
          />
        </button>
        <Button
          variant="secondary"
          size="icon-xs"
          aria-label="Remove Design Snapshot"
          title="Remove Design Snapshot"
          disabled={disabled}
          onClick={onRemove}
          className="absolute top-1 right-1 rounded-full opacity-0 group-hover/card:opacity-100 focus-visible:opacity-100"
        >
          <XIcon />
        </Button>
      </div>
      <input
        aria-label="Snapshot name"
        value={name}
        disabled={disabled}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            onRename(name)
          }
        }}
        className="w-full truncate rounded-sm bg-transparent px-0.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <Button
        variant="link"
        size="xs"
        disabled={disabled}
        onClick={onReplace}
        className="h-auto self-start px-0.5 text-xs"
      >
        Replace
      </Button>
    </li>
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
