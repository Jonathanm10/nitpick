import { useRef } from "react"
import type { BuildSummary } from "@nitpick/server/api"
import { CheckIcon, PackageIcon, UploadIcon } from "lucide-react"
import { cn } from "cn"
import { SectionLabel } from "@/components/studio"
import { Button } from "@/components/ui/button"

interface BuildDropZoneProps {
  readonly build: BuildSummary | undefined
  /** A file is being dragged over the page, which takes the drop anywhere. */
  readonly isDragging: boolean
  readonly disabled: boolean
  readonly onChoose: (file: File) => void
}

/**
 * Home's first card, after ContentView's drop zone: empty, it asks for a
 * zipped simulator Build or an Android .apk by drop anywhere or by the
 * picker; loaded, it names the Build under review.
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
        "flex min-h-64 flex-col gap-4 rounded-[14px] p-4 studio-card transition-shadow",
        isDragging && "shadow-[inset_0_0_0_1.5px_rgb(255_69_58/0.6)]"
      )}
    >
      <SectionLabel
        aside={
          build === undefined ? undefined : (
            <span className="flex items-center gap-1 text-green">
              <CheckIcon className="size-3" /> Loaded
            </span>
          )
        }
      >
        Build
      </SectionLabel>
      {build === undefined ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-[10px] border border-dashed border-white/15 bg-white/[0.015] p-6 text-center">
          <span className="flex size-11 items-center justify-center rounded-[11px] bg-white/[0.06] ring-1 ring-white/10">
            <UploadIcon className="size-5 text-text-2" />
          </span>
          <p className="text-[14px] font-medium">Drop a Build anywhere</p>
          <p className="max-w-64 text-[12.5px] text-text-2">
            A simulator Build (.zip) or an Android .apk, or choose one.
          </p>
        </div>
      ) : (
        <div className="flex flex-1 flex-col justify-center gap-3">
          <div className="flex items-center gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-[11px] bg-white/[0.06] ring-1 ring-white/10">
              <PackageIcon className="size-5 text-text-2" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-[17px] font-semibold tracking-[-0.01em]">
                {build.name}
              </p>
              <p className="font-mono text-[12px] text-text-2">
                {build.identity.version} ({build.identity.buildNumber})
              </p>
            </div>
            <span className="ml-auto rounded-[4px] px-1.5 font-mono text-[10px] text-text-2 ring-1 ring-white/10">
              {build.platform === "android" ? "Android" : "iOS"}
            </span>
          </div>
          <p className="truncate font-mono text-[11.5px] text-text-3 select-text">
            {build.identity.bundleID}
          </p>
        </div>
      )}
      <Button
        variant="outline"
        className="self-start"
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        {build === undefined ? "Choose Build…" : "Replace Build…"}
      </Button>
      <input
        ref={input}
        type="file"
        data-build-input=""
        accept=".zip,application/zip,.apk,application/vnd.android.package-archive"
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
