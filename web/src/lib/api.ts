// The page's calls to the nitpick server, typed by its contract.
import type {
  BuildResponse,
  CaptureResponse,
  DesignSnapshotResponse,
  ErrorResponse,
  FeedbackEnvironmentResponse,
  FeedbackRequest,
  FeedbackResponse,
  FilingResponse,
  FindingPatch,
  HistoryResponse,
  HostResponse,
  ProjectsResponse,
  ReviewStateResponse,
  SessionPatch,
  StartReviewRequest,
  StartReviewResponse,
  SwitchDeviceResponse,
} from "@nitpick/server/api"

/** A failed call, carrying the server's message for the error line. */
export class APIError extends Error {
  /** Undefined when the server was never reached. */
  readonly status: number | undefined
  readonly code: ErrorResponse["code"]

  constructor(message: string, status?: number, code?: ErrorResponse["code"]) {
    super(message)
    this.name = "APIError"
    this.status = status
    this.code = code
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, init)
  } catch {
    throw new APIError("The nitpick server could not be reached.")
  }
  if (!response.ok) {
    const body = (await response
      .json()
      .catch(() => null)) as ErrorResponse | null
    throw new APIError(
      body?.error ?? `The server answered ${response.status}.`,
      response.status,
      body?.code
    )
  }
  return (response.status === 204 ? undefined : await response.json()) as T
}

function json(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }
}

export const api = {
  review: () => call<ReviewStateResponse>("/api/review"),
  host: () => call<HostResponse>("/api/host"),
  projects: () => call<ProjectsResponse>("/api/projects"),
  uploadBuild: (file: File) =>
    call<BuildResponse>(`/api/build?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "Content-Type": "application/zip" },
      body: file,
    }),
  startReview: (request: StartReviewRequest) =>
    call<StartReviewResponse>("/api/session", json("POST", request)),
  switchDevice: (deviceUDID: string) =>
    call<SwitchDeviceResponse>(
      "/api/session/device",
      json("PUT", { deviceUDID })
    ),
  endReview: () => call<void>("/api/session", { method: "DELETE" }),
  editSession: (patch: SessionPatch) =>
    call<void>("/api/session", json("PATCH", patch)),
  capture: (deviceUDID: string) =>
    call<CaptureResponse>(
      "/api/session/captures",
      json("POST", { deviceUDID })
    ),
  editFinding: (itemID: string, patch: FindingPatch) =>
    call<void>(findingPath(itemID), json("PATCH", patch)),
  discardFinding: (itemID: string) =>
    call<void>(findingPath(itemID), { method: "DELETE" }),
  captureURL: (itemID: string) => `${findingPath(itemID)}/capture`,
  addDesignSnapshot: (itemID: string, file: Blob, name: string) =>
    call<DesignSnapshotResponse>(
      `${findingPath(itemID)}/design-snapshots?name=${encodeURIComponent(name)}`,
      { method: "POST", body: file }
    ),
  replaceDesignSnapshot: (itemID: string, snapshotID: string, file: File) =>
    call<DesignSnapshotResponse>(
      `${snapshotPath(itemID, snapshotID)}?name=${encodeURIComponent(file.name)}`,
      { method: "PUT", body: file }
    ),
  renameDesignSnapshot: (itemID: string, snapshotID: string, name: string) =>
    call<DesignSnapshotResponse>(
      snapshotPath(itemID, snapshotID),
      json("PATCH", { name })
    ),
  removeDesignSnapshot: (itemID: string, snapshotID: string) =>
    call<void>(snapshotPath(itemID, snapshotID), { method: "DELETE" }),
  designSnapshotURL: (itemID: string, dataVersion: string) =>
    `${findingPath(itemID)}/design-snapshot-data/${encodeURIComponent(dataVersion)}`,
  fileAll: () =>
    call<FilingResponse>("/api/session/filing", { method: "POST" }),
  dismissFilingResult: () =>
    call<void>("/api/filing-result", { method: "DELETE" }),
  history: () => call<HistoryResponse>("/api/history"),
  feedbackEnvironment: () =>
    call<FeedbackEnvironmentResponse>("/api/feedback/environment"),
  sendFeedback: (feedback: FeedbackRequest, image: Blob | undefined) => {
    const form = new FormData()
    form.set("feedback", JSON.stringify(feedback))
    if (image !== undefined) form.set("image", image, "image")
    return call<FeedbackResponse>("/api/feedback", {
      method: "POST",
      body: form,
    })
  },
}

function findingPath(itemID: string): string {
  return `/api/session/findings/${encodeURIComponent(itemID)}`
}

function snapshotPath(itemID: string, snapshotID: string): string {
  return `${findingPath(itemID)}/design-snapshots/${encodeURIComponent(snapshotID)}`
}
