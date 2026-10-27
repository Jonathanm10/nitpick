import { useRef } from "react"
import type { BuildSummary } from "@nitpick/server/api"
import { FileArchiveIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

interface BuildDropZoneProps {
  readonly build: BuildSummary | undefined
  /** A file is being dragged over the page, which takes the drop anywhere. */
  readonly isDragging: boolean
  readonly disabled: boolean
  readonly onChoose: (file: File) => void
}

/**
 * Home's entry point, after ContentView's drop zone: empty, it asks for a
 * zipped simulator Build by drop or by the picker; loaded, it names the Build
 * under review.
 */
export function BuildDropZone({
  build,
  isDragging,
  disabled,
  onChoose,
}: BuildDropZoneProps) {
  const input = useRef<HTMLInputElement>(null)

  return (
    <section
      aria-label="Build"
      className={cn(
        "flex min-h-52 flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-6 text-center transition-colors",
        isDragging ? "border-primary bg-muted" : "border-border"
      )}
    >
      {build === undefined ? (
        <>
          <FileArchiveIcon className="size-10 text-muted-foreground/60" />
          <p className="text-lg text-muted-foreground">
            Drop a simulator Build (.zip), or choose one.
          </p>
        </>
      ) : (
        <>
          <p className="text-2xl font-semibold">{build.name}</p>
          <p className="font-mono text-sm text-muted-foreground select-text">
            {build.identity.bundleID} {build.identity.version} (
            {build.identity.buildNumber})
          </p>
        </>
      )}
      <Button
        variant="outline"
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        Choose Build…
      </Button>
      <input
        ref={input}
        type="file"
        accept=".zip,application/zip"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ""
          if (file !== undefined) onChoose(file)
        }}
      />
    </section>
  )
}
