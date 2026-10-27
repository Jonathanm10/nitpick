// The page's keyboard chords, one table for the handlers and the shortcuts
// dialog. ⌘ becomes Ctrl off Apple platforms. A chord a browser or the OS
// keeps for itself gets a replacement here, and the dialog lists what is
// left (parity.md, "Keyboard chords").

/** Apple keyboards say ⌘ and ⌥; everyone else says Ctrl and Alt. */
export const isApplePlatform = /mac|iphone|ipad|ipod/i.test(
  (navigator as { userAgentData?: { platform?: string } }).userAgentData
    ?.platform ??
    navigator.platform ??
    navigator.userAgent
)

export interface Chord {
  /** How the dialog and the hints spell it. */
  readonly label: string
  readonly matches: (event: KeyboardEvent) => boolean
}

interface Modifiers {
  readonly command?: boolean
  readonly shift?: boolean
  readonly option?: boolean
}

/** `key` with exactly these modifiers; ⌘ is Ctrl off Apple platforms. */
function chord(
  key: string,
  label: { readonly apple: string; readonly other: string },
  { command = false, shift = false, option = false }: Modifiers
): Chord {
  return {
    label: isApplePlatform ? label.apple : label.other,
    matches: (event) =>
      event.key.toLowerCase() === key.toLowerCase() &&
      (isApplePlatform ? event.metaKey : event.ctrlKey) === command &&
      (isApplePlatform ? event.ctrlKey : event.metaKey) === false &&
      event.shiftKey === shift &&
      event.altKey === option,
  }
}

export const chords = {
  capture: chord("s", { apple: "⌘S", other: "Ctrl+S" }, { command: true }),
  undo: chord("z", { apple: "⌘Z", other: "Ctrl+Z" }, { command: true }),
  redo: chord(
    "z",
    { apple: "⇧⌘Z", other: "Ctrl+Shift+Z" },
    { command: true, shift: true }
  ),
  // ⌘R reloads the page in every browser, so Start and Resume review move to
  // ⌘⏎: the chord that goes to the Build.
  startReview: chord(
    "Enter",
    { apple: "⌘⏎", other: "Ctrl+Enter" },
    { command: true }
  ),
  // Ctrl+Alt+arrows rotate the screen on Windows machines with Intel's
  // graphics hotkeys, so Windows and Linux use Alt with the arrows.
  previousFinding: isApplePlatform
    ? chord(
        "ArrowUp",
        { apple: "⌥⌘↑", other: "" },
        { command: true, option: true }
      )
    : chord("ArrowUp", { apple: "", other: "Alt+↑" }, { option: true }),
  nextFinding: isApplePlatform
    ? chord(
        "ArrowDown",
        { apple: "⌥⌘↓", other: "" },
        { command: true, option: true }
      )
    : chord("ArrowDown", { apple: "", other: "Alt+↓" }, { option: true }),
} as const

/** What the shortcuts dialog lists, grouped as the page is. */
export const shortcutGroups: ReadonlyArray<{
  readonly title: string
  readonly shortcuts: ReadonlyArray<{
    readonly action: string
    readonly keys: string
  }>
}> = [
  {
    title: "Review",
    shortcuts: [
      { action: "Start or resume review", keys: chords.startReview.label },
      { action: "Capture", keys: chords.capture.label },
      { action: "Previous Finding", keys: chords.previousFinding.label },
      { action: "Next Finding", keys: chords.nextFinding.label },
    ],
  },
  {
    title: "Annotations, while no text field has focus",
    shortcuts: [
      { action: "Select", keys: "V" },
      { action: "Pen", keys: "P" },
      { action: "Arrow", keys: "A" },
      { action: "Rectangle", keys: "R" },
      { action: "Text label", keys: "T" },
      { action: "Undo", keys: chords.undo.label },
      { action: "Redo", keys: chords.redo.label },
    ],
  },
  {
    title: "The selected Annotation, once the capture has focus",
    shortcuts: [
      { action: "Nudge", keys: "← ↑ → ↓" },
      { action: "Nudge 5×", keys: "Shift + arrows" },
      { action: "Delete", keys: isApplePlatform ? "⌫" : "Delete" },
      { action: "Release, then discard an untouched capture", keys: "Esc" },
    ],
  },
  {
    title: "Text labels",
    shortcuts: [
      { action: "Place the label", keys: isApplePlatform ? "⏎" : "Enter" },
      { action: "Cancel the label", keys: "Esc" },
    ],
  },
  {
    title: "Design Snapshots",
    shortcuts: [
      {
        action: "Paste an image",
        keys: isApplePlatform ? "⌘V" : "Ctrl+V",
      },
    ],
  },
]

/** A text field, where letters, arrows, Delete and ⌘Z belong to the text. */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target instanceof HTMLTextAreaElement) return true
  if (target instanceof HTMLSelectElement) return true
  return (
    target instanceof HTMLInputElement &&
    !["button", "checkbox", "radio", "range", "submit", "reset"].includes(
      target.type
    )
  )
}
