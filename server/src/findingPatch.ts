// Reads the page's edits to a Finding and its session from untrusted JSON.
// An edit names only the fields it changes, so the last write wins per field
// when one Reviewer has several tabs open (PRD, open question 5).
import {
  annotationColors,
  findingTypes,
  trimWhitespaceAndNewlines,
  type Annotation,
  type Finding,
  type Point,
  type Rect,
} from "@nitpick/core"
import type { FindingPatch, SessionPatch } from "./api.ts"

/** The request body isn't the shape the route takes. */
export class MalformedEdit extends Error {
  constructor(problem: string) {
    super(`The edit is malformed: ${problem}.`)
    this.name = "MalformedEdit"
  }
}

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] }

export function parseFindingPatch(body: Record<string, unknown>): FindingPatch {
  const patch: Mutable<FindingPatch> = {}
  for (const [key, value] of Object.entries(body)) {
    switch (key) {
      case "summary":
      case "description":
        patch[key] = expectString(value, key)
        break
      case "type":
        if (!findingTypes.includes(value as never)) fail(`${key} is unknown`)
        patch.type = value as Finding["type"]
        break
      case "priority":
        patch.priority =
          value === null
            ? null
            : { name: expectString(field(value, "name", key), key) }
        break
      case "assignee":
        patch.assignee =
          value === null
            ? null
            : {
                login: expectString(field(value, "login", key), key),
                fullName: expectString(field(value, "fullName", key), key),
              }
        break
      case "designReference":
        patch.designReference = value === null ? null : expectString(value, key)
        break
      case "annotations":
        patch.annotations = parseAnnotations(value, key)
        break
      default:
        fail(`${key} is not an editable field`)
    }
  }
  return patch
}

export function parseSessionPatch(body: Record<string, unknown>): SessionPatch {
  for (const key of Object.keys(body)) {
    if (key !== "designReference") fail(`${key} is not an editable field`)
  }
  const value = body.designReference
  if (value === undefined) return {}
  return {
    designReference:
      value === null ? null : expectString(value, "designReference"),
  }
}

/** The Finding with the patch's fields; absent fields stay as they are. */
export function patchedFinding(finding: Finding, patch: FindingPatch): Finding {
  const next: Mutable<Finding> = { ...finding }
  if (patch.summary !== undefined) next.summary = patch.summary
  if (patch.description !== undefined) next.description = patch.description
  if (patch.type !== undefined) next.type = patch.type
  if (patch.priority !== undefined) {
    next.priority = patch.priority ?? undefined
  }
  if (patch.assignee !== undefined) {
    next.assignee = patch.assignee ?? undefined
  }
  if (patch.designReference !== undefined) {
    next.designReference = designReference(patch.designReference)
  }
  if (patch.annotations !== undefined) next.annotations = patch.annotations
  return next
}

/** A pasted Figma URL, or undefined when blank: absent is a first-class state. */
export function designReference(text: string | null): string | undefined {
  const trimmed = trimWhitespaceAndNewlines(text ?? "")
  return trimmed === "" ? undefined : trimmed
}

/** Annotations from untrusted JSON, each checked as the Editor makes them. */
export function parseAnnotations(value: unknown, key: string): Annotation[] {
  if (!Array.isArray(value)) fail(`${key} is not an array`)
  return value.map((element, index) => annotation(element, `${key}[${index}]`))
}

function annotation(value: unknown, path: string): Annotation {
  const color = field(value, "color", path)
  if (!annotationColors.includes(color as never)) {
    fail(`${path}.color is unknown`)
  }
  const kind = field(value, "kind", path)
  const base = { color: color as Annotation["color"] }
  switch (kind) {
    case "pen": {
      const points = field(value, "points", path)
      if (!Array.isArray(points)) fail(`${path}.points is not an array`)
      return {
        kind,
        ...base,
        points: points.map((element) => point(element, `${path}.points`)),
      }
    }
    case "arrow":
      return {
        kind,
        ...base,
        from: point(field(value, "from", path), `${path}.from`),
        to: point(field(value, "to", path), `${path}.to`),
      }
    case "rectangle":
      return { kind, ...base, rect: rect(field(value, "rect", path), path) }
    case "label":
      return {
        kind,
        ...base,
        text: expectString(field(value, "text", path), `${path}.text`),
        at: point(field(value, "at", path), `${path}.at`),
      }
    default:
      return fail(`${path}.kind is unknown`)
  }
}

function point(value: unknown, path: string): Point {
  return {
    x: finite(field(value, "x", path), path),
    y: finite(field(value, "y", path), path),
  }
}

function rect(value: unknown, path: string): Rect {
  return {
    ...point(value, `${path}.rect`),
    width: finite(field(value, "width", path), `${path}.rect`),
    height: finite(field(value, "height", path), `${path}.rect`),
  }
}

function field(value: unknown, key: string, path: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${path} is not an object`)
  }
  return (value as Record<string, unknown>)[key]
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== "string") fail(`${path} is not a string`)
  return value
}

function finite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${path} has a coordinate that is not a number`)
  }
  return value
}

function fail(problem: string): never {
  throw new MalformedEdit(problem)
}
